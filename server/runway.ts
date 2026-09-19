import { assertPreflight } from './decision-providers';
import { z } from 'zod';
import { open, rename, rm } from 'node:fs/promises';
import { config } from './config';
import { base, get, list, save, transaction } from './db';
import { checkBudget, DomainError } from './policy';
import { JobDeferred } from './queue';
import { assetFile, mediaPath, prepareDir, probe } from './media';
import type { Generation, Job, Project, Scene } from '../shared/domain';

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
async function downloadVideo(url: string, key: string, signal: AbortSignal) {
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
          'Runway video exceeded the 250 MB download limit.',
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
  if (!job.sceneId) throw new DomainError('Missing video scene');
  const scene = get<Scene>('scene', job.sceneId);
  if (scene.assetId) return;
  if (p.aspect === '1:1')
    throw new DomainError('Runway MVP supports portrait and landscape video.');
  const duration = runwayDuration(scene.durationSeconds);
  if (scene.prompt.length > 1000)
    throw new DomainError(
      'Shorten the scene prompt to 1,000 characters for Runway.',
    );
  let generation = list<Generation>('generation', p.id).find(
    (g) => g.jobId === job.id,
  );
  if (!generation) {
    // Gate new purchases without preventing recovery of a task already submitted.
    assertPreflight(p);
    signal.throwIfAborted();
    generation = transaction(() => {
      const fresh = get<Project>('project', p.id);
      const cost = duration * RUNWAY_USD_PER_SECOND;
      checkBudget(
        fresh,
        cost,
        list<Generation>('generation', p.id).filter(
          (g) => g.sceneId === scene.id,
        ).length,
      );
      const record = save<Generation>('generation', {
        ...base(),
        projectId: p.id,
        sceneId: scene.id,
        jobId: job.id,
        provider: 'runway',
        model: RUNWAY_MODEL,
        requestId: job.key,
        prompt: scene.prompt,
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
      save('scene', { ...scene, provider: 'runway', status: 'generating' });
      return record;
    });
    try {
      const response = await request('text_to_video', 'POST', signal, {
        model: RUNWAY_MODEL,
        promptText: scene.prompt,
        duration,
        ratio: p.aspect === '9:16' ? '720:1280' : '1280:720',
        outputFormat: 'mp4',
      });
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
    save('scene', { ...get<Scene>('scene', scene.id), status: 'planned' });
    throw new DomainError(`Runway task ${task.status.toLowerCase()}.`);
  }
  if (!task.output?.[0])
    throw new DomainError(
      'Runway completed without a video URL. Retry retrieves the saved task.',
    );
  await prepareDir(p.id);
  const key = `${p.id}/${scene.id}-r${scene.revision}-runway.mp4`;
  await downloadVideo(task.output[0], key, signal);
  const info = await probe(mediaPath(key), signal);
  const video = info.streams.find((s) => s.codec_type === 'video');
  if (
    !video?.width ||
    !video.height ||
    Number(info.format.duration) < scene.durationSeconds - 0.15
  )
    throw new DomainError(
      'Runway clip is missing video or shorter than its scene. Paid task is saved.',
    );
  const asset = await assetFile(p, 'video', key, {
    sceneId: scene.id,
    provider: 'runway',
    prompt: scene.prompt,
    costUsd: generation.actualUsd,
    width: video.width,
    height: video.height,
    duration: Number(info.format.duration),
    revision: scene.revision,
    parameters: {
      developmentPlaceholder: false,
      model: RUNWAY_MODEL,
      providerRequestId: generation.remoteTaskId,
      requestedSeconds: duration,
    },
    license:
      'AI-generated using Runway; subject to provider terms and user rights review.',
  });
  transaction(() => {
    save<Generation>('generation', {
      ...generation!,
      status: 'completed',
      assetId: asset.id,
      latencyMs: Date.now() - Date.parse(generation!.createdAt),
    });
    save('scene', {
      ...get<Scene>('scene', scene.id),
      status: 'generated',
      provider: 'runway',
      assetId: asset.id,
    });
  });
}
