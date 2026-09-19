import { assertPreflight } from './decision-providers';
import { z } from 'zod';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { config } from './config';
import { base, get, list, save, transaction } from './db';
import { checkBudget, DomainError } from './policy';
import { JobDeferred } from './queue';
import {
  assetFile,
  mediaPath,
  prepareDir,
  probe,
  runProcess,
  reviewFrames,
} from './media';
import type { Asset, Generation, Job, Project, Scene } from '../shared/domain';

export const RUNWAY_MODEL = 'gen4.5';
export const RUNWAY_USD_PER_SECOND = 0.12;
export const runwayTransport = {
  fetch: (input: string, init?: RequestInit) => fetch(input, init),
};
const creditSchema = z.object({ credits: z.number().nonnegative() });
const taskSchema = z.object({
  id: z.uuid(),
  status: z.enum([
    'PENDING',
    'THROTTLED',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
  ]),
  cost: creditSchema.optional(),
  output: z.array(z.url()).optional(),
});
export function requireRunway() {
  if (!config.RUNWAY_API_KEY)
    throw new DomainError(
      'Set RUNWAY_API_KEY on the server and restart before using Runway.',
    );
}
export function runwayDuration(seconds: number) {
  if (seconds < 2 || seconds > 10)
    throw new DomainError('Runway scenes must be between 2 and 10 seconds.');
  return Math.ceil(seconds);
}
async function boundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty Runway response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1_000_000) throw new Error('Runway response too large');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
function request(
  path: string,
  method: string,
  signal: AbortSignal,
  body?: unknown,
) {
  return runwayTransport.fetch(`https://api.dev.runwayml.com/v1/${path}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    headers: {
      Authorization: `Bearer ${config.RUNWAY_API_KEY}`,
      'X-Runway-Version': '2024-11-06',
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
export function validateRunwayOutputUrl(value: string) {
  const url = new URL(value);
  // Output URLs come only from the authenticated task response. Limit downloads
  // to Runway's CDN/domain, never send credentials, and do not follow redirects.
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !['cloudfront.net', 'runwayml.com'].some((domain) =>
      url.hostname.endsWith(`.${domain}`),
    )
  ) {
    throw new DomainError(
      'Runway returned an unsupported media host. No download was attempted.',
    );
  }
  return url.toString();
}
async function downloadMedia(url: string, key: string, signal: AbortSignal) {
  const response = await runwayTransport.fetch(validateRunwayOutputUrl(url), {
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
  });
  if (!response.ok || !response.body)
    throw new Error(
      'Runway media download failed; retry retrieves the existing task.',
    );
  const temp = mediaPath(`${key}.partial`);
  const file = await open(temp, 'w');
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 250_000_000)
        throw new DomainError(
          'Runway media exceeded the 250 MB download limit.',
        );
      let offset = 0;
      while (offset < next.value.length) {
        const result = await file.write(next.value, offset);
        offset += result.bytesWritten;
      }
    }
    if (!size) throw new Error('Runway returned empty media');
    await file.sync();
    await file.close();
    await rename(temp, mediaPath(key));
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temp, { force: true });
    throw error;
  } finally {
    await reader.cancel();
  }
}

export async function generateRunway(job: Job, signal: AbortSignal) {
  requireRunway();
  const p = get<Project>('project', job.projectId);
  const image =
    job.type === 'reference_image' || job.type === 'storyboard_image';
  const reference = job.type === 'reference_image';
  const scene = job.sceneId ? get<Scene>('scene', job.sceneId) : undefined;
  if (!reference && (!scene || scene.projectId !== p.id))
    throw new DomainError('Missing project scene');
  const existingAsset = reference
    ? p.referenceAssetId
    : image
      ? scene?.storyboardAssetId
      : scene?.assetId;
  // Older jobs encode their revision in the idempotency key, before payload snapshots existed.
  const legacyRevision = job.key.match(/:r(\d+)$/)?.[1];
  const expectedRevision =
    (image ? job.payload.visualRevision : job.payload.sceneRevision) ??
    (legacyRevision ? Number(legacyRevision) : undefined);
  const currentRevision = reference
    ? (p.referenceRevision ?? 1)
    : image
      ? (scene!.storyboardRevision ?? 1)
      : scene!.revision;
  if (expectedRevision !== undefined && expectedRevision !== currentRevision)
    throw new DomainError(
      'This job belongs to an older visual revision. Its paid task is retained in Generations; it cannot replace the current selection.',
    );
  if (existingAsset) return;
  if (p.aspect === '1:1')
    throw new DomainError(
      'Runway supports portrait and landscape in this studio.',
    );
  const duration = image ? 0 : runwayDuration(scene!.durationSeconds);
  const prompt = reference
    ? p.referencePrompt
    : image
      ? scene!.imagePrompt
        ? `@identity. ${scene!.imagePrompt}`
        : undefined
      : scene!.prompt;
  if (!prompt || prompt.length > 1000)
    throw new DomainError('Use a complete prompt of at most 1,000 characters.');
  const model = image ? 'gen4_image' : RUNWAY_MODEL;
  const targetRevision = reference
    ? (p.referenceRevision ?? 1)
    : image
      ? (scene!.storyboardRevision ?? 1)
      : scene!.revision;
  const parentId = reference
    ? undefined
    : image
      ? p.referenceAssetId
      : p.productionApproach === 'image_to_video'
        ? scene!.storyboardAssetId
        : undefined;
  let generation = list<Generation>('generation', p.id).find(
    (g) => g.jobId === job.id,
  );
  if (!generation) {
    // Gate new purchases without preventing recovery of a task already submitted.
    if (!image) assertPreflight(p);
    if (image && p.productionApproach !== 'image_to_video')
      throw new DomainError('Enable image-first production first.');
    if (
      !reference &&
      p.productionApproach === 'image_to_video' &&
      (!p.referenceApproved ||
        !p.referenceAssetId ||
        (!image && (!scene!.storyboardApproved || !scene!.storyboardAssetId)))
    )
      throw new DomainError(
        'Approve the visual reference and scene starting images before continuing.',
      );
    const parent = parentId ? get<Asset>('asset', parentId) : undefined;
    if (
      parent &&
      (parent.projectId !== p.id ||
        (image
          ? parent.type !== 'reference_image'
          : parent.type !== 'storyboard_image' || parent.sceneId !== scene!.id))
    )
      throw new DomainError(
        'Image does not belong to this production and scene.',
      );
    const inputImage = parent ? await imageDataUri(parent, signal) : undefined;
    signal.throwIfAborted();
    generation = transaction(() => {
      const fresh = get<Project>('project', p.id);
      const cost = image ? 0.08 : duration * RUNWAY_USD_PER_SECOND;
      checkBudget(
        fresh,
        cost,
        list<Generation>('generation', p.id).filter(
          (g) => g.sceneId === scene?.id && g.model === model,
        ).length,
      );
      const record = save<Generation>('generation', {
        ...base(),
        projectId: p.id,
        sceneId: scene?.id,
        jobId: job.id,
        provider: 'runway',
        model,
        requestId: job.key,
        prompt,
        attempt: job.attempt,
        estimatedUsd: cost,
        actualUsd: 0,
        status: 'submitting',
      } satisfies Generation);
      save('project', {
        ...fresh,
        reservedUsd: fresh.reservedUsd + cost,
        generationAttempts: fresh.generationAttempts + 1,
      });
      if (scene && !image)
        save('scene', { ...scene, provider: 'runway', status: 'generating' });
      return record;
    });
    try {
      const response = await request(
        image
          ? 'text_to_image'
          : inputImage
            ? 'image_to_video'
            : 'text_to_video',
        'POST',
        signal,
        image
          ? {
              model,
              promptText: prompt,
              ratio: p.aspect === '9:16' ? '1080:1920' : '1920:1080',
              ...(inputImage
                ? { referenceImages: [{ uri: inputImage, tag: 'identity' }] }
                : {}),
            }
          : {
              model,
              promptText: prompt,
              duration,
              ratio: p.aspect === '9:16' ? '720:1280' : '1280:720',
              ...(inputImage
                ? { promptImage: inputImage }
                : { outputFormat: 'mp4' }),
            },
      );
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408
      ) {
        await response.body?.cancel();
        transaction(() => {
          const fresh = get<Project>('project', p.id);
          save('project', {
            ...fresh,
            reservedUsd: Math.max(
              0,
              fresh.reservedUsd - generation!.estimatedUsd,
            ),
          });
          generation = save<Generation>('generation', {
            ...generation!,
            status: 'failed',
            error: `Runway rejected the request (HTTP ${response.status}). Check credentials, credits and prompt.`,
          });
          if (scene && !image)
            save('scene', {
              ...get<Scene>('scene', scene.id),
              status: 'planned',
            });
        });
        throw new DomainError(generation!.error!);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Unknown submission outcome');
      }
      const result = z
        .object({
          id: z.uuid(),
          estimatedCost: creditSchema.optional(),
        })
        .parse(await boundedJson(response));
      generation = save<Generation>('generation', {
        ...generation,
        status: 'submitted',
        remoteTaskId: result.id,
      });
      if (
        result.estimatedCost &&
        result.estimatedCost.credits * 0.01 > generation.estimatedUsd + 0.000001
      ) {
        const reportedEstimate = result.estimatedCost.credits * 0.01;
        generation = transaction(() => {
          const fresh = get<Project>('project', p.id);
          save('project', {
            ...fresh,
            reservedUsd:
              fresh.reservedUsd + reportedEstimate - generation!.estimatedUsd,
          });
          return save<Generation>('generation', {
            ...generation!,
            estimatedUsd: reportedEstimate,
          });
        });
        throw new DomainError(
          'Runway reports a higher estimate than the saved rate. Task ID saved; pause for billing review before resuming.',
        );
      }
    } catch (error) {
      if (generation.status === 'submitting') {
        generation = save<Generation>('generation', {
          ...generation,
          status: 'uncertain',
          error:
            'Runway submission outcome is unknown. Reservation retained; check the developer portal before authorizing another generation.',
        });
      }
      throw error instanceof DomainError
        ? error
        : new DomainError(
            generation.error ?? 'Runway submission could not be confirmed.',
          );
    }
    throw new JobDeferred();
  }
  if (generation.status === 'failed')
    throw new DomainError(
      generation.error ??
        'Runway task failed. Review before requesting a new revision.',
    );
  if (!generation.remoteTaskId)
    throw new DomainError(
      generation.error ??
        'Submission interrupted before a task ID was saved. Reservation retained; check Runway before regenerating.',
    );
  let task: z.infer<typeof taskSchema>;
  try {
    const response = await request(
      `tasks/${generation.remoteTaskId}`,
      'GET',
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Task lookup failed');
    }
    task = taskSchema.parse(await boundedJson(response));
    if (task.id !== generation.remoteTaskId)
      throw new Error('Task ID mismatch');
  } catch {
    if (Date.now() - Date.parse(generation.createdAt) > 45 * 60_000)
      throw new DomainError(
        'Runway status is unavailable. Task ID and reservation are saved; retry to check the same task.',
      );
    throw new JobDeferred(15000);
  }
  if (['PENDING', 'THROTTLED', 'RUNNING'].includes(task.status)) {
    if (Date.now() - Date.parse(generation.createdAt) > 45 * 60_000)
      throw new DomainError(
        'Runway task is still pending after 45 minutes. Retry later to check the same task.',
      );
    throw new JobDeferred();
  }
  if (!generation.billed) {
    if (task.status !== 'SUCCEEDED' && !task.cost)
      throw new DomainError(
        'Runway task ended without billing details. Reservation retained for reconciliation.',
      );
    generation = transaction(() => {
      const fresh = get<Project>('project', p.id);
      const cost = task.cost
        ? task.cost.credits * 0.01
        : generation!.estimatedUsd;
      save('project', {
        ...fresh,
        reservedUsd: Math.max(0, fresh.reservedUsd - generation!.estimatedUsd),
        spentUsd: fresh.spentUsd + cost,
      });
      return save<Generation>('generation', {
        ...generation!,
        billed: true,
        actualUsd: cost,
        costBasis: task.cost
          ? 'Reported Runway credits × $0.01 (excludes tax)'
          : image
            ? 'Published Gen-4 Image 1080p rate (excludes tax)'
            : 'Published Gen-4.5 rate × requested seconds (excludes tax)',
      });
    });
  }
  if (task.status !== 'SUCCEEDED') {
    save<Generation>('generation', {
      ...generation,
      status: 'failed',
      error: `Runway task ${task.status.toLowerCase()}. Review the developer portal before creating another revision.`,
    });
    if (scene && !image)
      save('scene', { ...get<Scene>('scene', scene.id), status: 'planned' });
    throw new DomainError(`Runway task ${task.status.toLowerCase()}.`);
  }
  if (!task.output?.[0])
    throw new DomainError(
      'Runway completed without a media URL. Retry retrieves the saved task.',
    );
  await prepareDir(p.id);
  const key = `${p.id}/${scene?.id ?? 'reference'}-${job.type}-r${targetRevision}-runway.${image ? 'jpg' : 'mp4'}`;
  const downloadKey = image ? `${key}.source` : key;
  await downloadMedia(task.output[0], downloadKey, signal);
  if (image) {
    await runProcess(
      config.FFMPEG_PATH,
      [
        '-y',
        '-i',
        mediaPath(downloadKey),
        '-frames:v',
        '1',
        '-q:v',
        '2',
        mediaPath(key),
      ],
      signal,
    );
    await rm(mediaPath(downloadKey), { force: true });
  }
  const info = await probe(mediaPath(key), signal);
  const video = info.streams.find((s) => s.codec_type === 'video');
  if (
    !video?.width ||
    !video.height ||
    (!image &&
      (!Number.isFinite(Number(info.format.duration)) ||
        Number(info.format.duration) < scene!.durationSeconds - 0.15))
  )
    throw new DomainError(
      'Runway clip is missing video or shorter than its scene. Paid task is saved.',
    );
  const asset =
    list<Asset>('asset', p.id).find(
      (a) => a.parameters.providerRequestId === generation!.remoteTaskId,
    ) ??
    (await assetFile(
      p,
      reference ? 'reference_image' : image ? 'storyboard_image' : 'video',
      key,
      {
        sceneId: scene?.id,
        provider: 'runway',
        prompt,
        costUsd: generation.actualUsd,
        width: video.width,
        height: video.height,
        duration: image ? 0 : Number(info.format.duration),
        mime: image ? 'image/jpeg' : 'video/mp4',
        parentAssetId: parentId,
        revision: targetRevision,
        parameters: {
          developmentPlaceholder: false,
          model,
          providerRequestId: generation.remoteTaskId,
          requestedSeconds: duration,
        },
        license:
          'AI-generated using Runway; subject to provider terms and user rights review.',
      },
    ));
  const frames =
    !image && p.productionApproach === 'image_to_video'
      ? await reviewFrames(p, scene!, asset, signal)
      : [];
  transaction(() => {
    save<Generation>('generation', {
      ...generation!,
      status: 'completed',
      assetId: asset.id,
      latencyMs: Date.now() - Date.parse(generation!.createdAt),
    });
    if (reference)
      save('project', {
        ...get<Project>('project', p.id),
        referenceAssetId: asset.id,
        referenceApproved: false,
      });
    else if (image)
      save('scene', {
        ...get<Scene>('scene', scene!.id),
        storyboardAssetId: asset.id,
        storyboardApproved: false,
      });
    else
      save('scene', {
        ...get<Scene>('scene', scene!.id),
        status: 'generated',
        provider: 'runway',
        assetId: asset.id,
        reviewFrameIds: frames.map((a) => a.id),
      });
  });
}

async function imageDataUri(asset: Asset, signal: AbortSignal) {
  const key = `${asset.path}.input.jpg`;
  await runProcess(
    config.FFMPEG_PATH,
    [
      '-y',
      '-i',
      mediaPath(asset.path),
      '-vf',
      'scale=1280:1280:force_original_aspect_ratio=decrease',
      '-frames:v',
      '1',
      '-q:v',
      '3',
      mediaPath(key),
    ],
    signal,
  );
  const bytes = await readFile(mediaPath(key));
  await rm(mediaPath(key), { force: true });
  if (bytes.length > 3_000_000)
    throw new DomainError('Reference image is too large to send.');
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
}
