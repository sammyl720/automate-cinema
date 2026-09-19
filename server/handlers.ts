import { base, get, list, save, event, transaction } from './db';
import type {
  Project,
  Job,
  Scene,
  Concept,
  Script,
  Generation,
  Asset,
  Evaluation,
  PlatformPackage,
} from '../shared/domain';
import { trace } from './creative';
import {
  creativeProvider,
  persistStoryboard,
  planVisuals,
} from './creative-providers';
import { generateRunway } from './runway';
import { decisionProvider, assertPreflight } from './decision-providers';
import { generateMusic } from './music';
import { spokenNarration } from './narration';
import { transition, assertScriptReady, assertClipsReviewed } from './service';
import { checkBudget, selectVideoProvider, DomainError } from './policy';
import {
  providerRegistry,
  videoProviders,
  developmentNarration,
} from './providers';
import {
  assetFile,
  dimensions,
  probe,
  mediaPath,
  renderTimeline,
  subtitles,
  writePackage,
} from './media';
export async function handle(job: Job, signal: AbortSignal) {
  let p = get<Project>('project', job.projectId);
  signal.throwIfAborted();
  // A crash may occur after committing a stage and before acknowledging its job.
  // Replaying that job must not move a completed workflow backwards.
  if (job.type === 'script' && list<Script>('script', p.id).length) return;
  if (job.type === 'storyboard') {
    assertScriptReady(p);
    if (p.state === 'assets_planned') return;
  }
  if (
    job.type === 'evaluate' &&
    ['approved', 'revision_required'].includes(p.state) &&
    list<Evaluation>('evaluation', p.id).length
  )
    return;
  if (job.type === 'package' && p.state === 'packaged') return;
  event(p.id, `${job.type}.started`, { jobId: job.id, attempt: job.attempt });
  if (job.type === 'concepts') {
    if (!list<Concept>('concept', p.id).length) {
      const concepts = await creativeProvider(p).concepts(p, job, signal);
      transaction(() => {
        for (const c of concepts) save('concept', c);
      });
    }
  }
  if (job.type === 'concepts')
    await decisionProvider(p).evaluateConcepts(
      p,
      list<Concept>('concept', p.id),
      job,
      signal,
    );
  if (job.type === 'visual_plan') await planVisuals(p, job, signal);
  if (job.type === 'reference_image' || job.type === 'storyboard_image') {
    await generateRunway(job, signal);
    return;
  }
  if (['narration', 'music', 'render'].includes(job.type))
    assertClipsReviewed(p, list<Scene>('scene', p.id));
  if (job.type === 'preflight')
    await decisionProvider(p).evaluateCreativePreflight(
      p,
      list<Scene>('scene', p.id),
      job,
      signal,
    );
  if (job.type === 'generate' && p.videoProvider !== 'runway')
    assertPreflight(p);
  if (job.type === 'script') {
    if (!p.selectedConceptId) throw new DomainError('No selected concept');
    p = transition(p, 'script_drafting');
    if (!list<Script>('script', p.id).length) {
      const c = get<Concept>('concept', p.selectedConceptId!);
      const scenes = await creativeProvider(p).script(p, c, job, signal);
      transaction(() => {
        for (const s of scenes) save('scene', s);
        save('script', {
          ...base(),
          projectId: p.id,
          title: p.title,
          hook: c.hook,
          ending: c.ending,
          version: 1,
          estimatedDurationSeconds: p.duration,
          narration: scenes.map((s) => ({
            sceneNumber: s.sceneNumber,
            text: s.narration,
            start: s.startTime,
            end: s.endTime,
          })),
        } satisfies Script);
      });
    }
  }
  if (job.type === 'storyboard') {
    p = transition(p, 'storyboarding');
    const scenes = list<Scene>('scene', p.id);
    persistStoryboard(
      await creativeProvider(p).storyboard(p, scenes, job, signal),
    );
    transition(p, 'assets_planned');
  }
  if (job.type === 'generate' && p.videoProvider === 'runway') {
    await generateRunway(job, signal);
    return;
  }
  if (job.type === 'generate') {
    if (!job.sceneId) throw new DomainError('Missing scene');
    let s = get<Scene>('scene', job.sceneId);
    if (s.assetId) return;
    const provider = selectVideoProvider(s, p, providerRegistry);
    let generation: Generation;
    transaction(() => {
      p = get<Project>('project', p.id);
      const prior = list<Generation>('generation', p.id);
      const reservation = prior.find(
        (g) => g.jobId === job.id && g.status === 'reserved',
      );
      if (reservation) {
        generation = reservation;
        return;
      }
      checkBudget(
        p,
        provider.costPerSecond * s.durationSeconds,
        prior.filter((g) => g.sceneId === s.id).length,
      );
      generation = save('generation', {
        ...base(),
        projectId: p.id,
        sceneId: s.id,
        jobId: job.id,
        provider: provider.id,
        model: provider.model,
        requestId: job.key,
        prompt: s.prompt,
        attempt: job.attempt,
        estimatedUsd: provider.costPerSecond * s.durationSeconds,
        actualUsd: 0,
        status: 'reserved',
      } satisfies Generation);
      save('project', {
        ...p,
        reservedUsd: p.reservedUsd + generation.estimatedUsd,
        generationAttempts: p.generationAttempts + 1,
      });
    });
    s = save('scene', { ...s, status: 'generating' });
    const started = Date.now();
    try {
      const result = await videoProviders[provider.id].generate({
        project: p,
        scene: s,
        idempotencyKey: job.key,
        signal,
      });
      signal.throwIfAborted();
      if (result.status !== 'completed' || !result.storageKey)
        throw new DomainError('Provider did not return completed media');
      const metadata = await probe(mediaPath(result.storageKey), signal);
      if (!metadata.streams.some((x) => x.codec_type === 'video'))
        throw new Error('Generated file has no video stream');
      const [width, height] = dimensions(p.aspect, p.quality);
      const previous = list<Asset>('asset', p.id)
        .filter((a) => a.sceneId === s.id)
        .at(-1);
      const asset = await assetFile(p, 'video', result.storageKey, {
        sceneId: s.id,
        prompt: s.prompt,
        duration: s.durationSeconds,
        width,
        height,
        revision: s.revision,
        parentAssetId: previous?.id,
        parameters: {
          providerRequestId: result.providerRequestId,
          negativePrompt: s.negativePrompt,
          quality: p.quality,
          developmentPlaceholder: true,
        },
      });
      transaction(() => {
        save('scene', { ...s, status: 'generated', assetId: asset.id });
        const fresh = get<Project>('project', p.id);
        save('project', {
          ...fresh,
          reservedUsd: Math.max(
            0,
            fresh.reservedUsd - generation!.estimatedUsd,
          ),
          spentUsd: fresh.spentUsd + result.costUsd,
        });
        save('generation', {
          ...generation!,
          status: 'completed',
          assetId: asset.id,
          actualUsd: result.costUsd,
          latencyMs: Date.now() - started,
        });
        trace(
          p.id,
          'video',
          { prompt: s.prompt, model: provider.model },
          { assetId: asset.id },
          s.id,
        );
      });
    } catch (e) {
      transaction(() => {
        const fresh = get<Project>('project', p.id);
        save('project', {
          ...fresh,
          reservedUsd: Math.max(
            0,
            fresh.reservedUsd - generation!.estimatedUsd,
          ),
        });
        save('generation', {
          ...generation!,
          status: 'failed',
          error: e instanceof Error ? e.message : String(e),
        });
        save('scene', { ...s, status: 'planned' });
      });
      throw e;
    }
  }
  if (
    job.type === 'narration' &&
    ['openai', 'elevenlabs'].includes(p.narrationProvider)
  ) {
    await spokenNarration(p, job, signal);
  }
  if (
    job.type === 'narration' &&
    !['openai', 'elevenlabs'].includes(p.narrationProvider)
  ) {
    const scenes = list<Scene>('scene', p.id);
    const result = await developmentNarration.generate({
      project: p,
      transcript: scenes.map((s) => s.narration).join(' '),
      signal,
    });
    await assetFile(p, 'narration', result.storageKey, {
      duration: p.duration,
      revision: p.revision,
      parameters: {
        isSpeech: result.isSpeech,
        developmentPlaceholder: true,
        transcript: scenes.map((s) => s.narration).join(' '),
        voice: 'test-tone',
        license: 'generated',
      },
    });
    await subtitles(p, scenes);
  }
  if (job.type === 'music') await generateMusic(p, job, signal);
  if (job.type === 'render') {
    p = transition(p, 'assembling');
    await renderTimeline(
      p,
      list<Scene>('scene', p.id),
      list<Asset>('asset', p.id),
      signal,
    );
  }
  if (job.type === 'evaluate') {
    p = transition(p, 'evaluating');
    const asset = list<Asset>('asset', p.id)
      .filter((a) => a.type === 'render' && a.revision === p.revision)
      .at(-1);
    if (!asset) throw new DomainError('No current render');
    const info = await probe(mediaPath(asset.path), signal);
    const duration = Number(info.format.duration);
    const [w, h] = dimensions(p.aspect, 'final');
    const video = info.streams.find((s) => s.codec_type === 'video');
    const issues: string[] = [];
    if (!Number.isFinite(duration) || Math.abs(duration - p.duration) > 0.5)
      issues.push('Render duration differs from script');
    if (video?.width !== w || video?.height !== h)
      issues.push('Export dimensions are incorrect');
    if (!info.streams.some((s) => s.codec_type === 'audio'))
      issues.push('Audio stream is missing');
    const passed = issues.length === 0;
    save('evaluation', {
      ...base(),
      projectId: p.id,
      score: passed ? 100 : 0,
      passed,
      method:
        'ffprobe technical checks only; cinematic and speech review unavailable',
      issues,
      recommendedChanges: [
        'Review visual quality, factual accuracy, rights, narration and pacing before publishing. Check the recorded video and audio provenance before release.',
      ],
      metrics: {
        duration,
        width: video?.width ?? 0,
        height: video?.height ?? 0,
        hasAudio: info.streams.some((s) => s.codec_type === 'audio'),
        creativeReviewPerformed: false,
      },
    } satisfies Evaluation);
    transition(p, passed ? 'approved' : 'revision_required');
  }
  if (job.type === 'package') {
    const assets = list<Asset>('asset', p.id);
    const render = assets
      .filter((a) => a.type === 'render' && a.revision === p.revision)
      .at(-1);
    const subtitle = assets
      .filter((a) => a.type === 'subtitles' && a.path.endsWith('.srt'))
      .at(-1);
    const thumbnail = assets
      .filter((a) => a.type === 'thumbnail' && a.revision === p.revision)
      .at(-1);
    if (!render || !subtitle || !thumbnail)
      throw new DomainError('Render, subtitles and thumbnail are required');
    for (const platform of ['TikTok', 'Instagram Reels', 'YouTube Shorts']) {
      if (
        list<PlatformPackage>('package', p.id).some(
          (a) => a.platform === platform,
        )
      )
        continue;
      const pack: PlatformPackage = {
        ...base(),
        projectId: p.id,
        platform,
        title: platform === 'YouTube Shorts' ? p.title.slice(0, 100) : p.title,
        caption: `${p.title}\n${p.brief.slice(0, platform === 'TikTok' ? 150 : 400)}`,
        hashtags: ['OriginalStory', 'Cinematic', 'SyntheticMedia'],
        assetId: render.id,
        subtitleAssetId: subtitle.id,
        thumbnailAssetId: thumbnail.id,
        disclosure:
          (p.musicProvider === 'elevenlabs'
            ? 'AI-generated instrumental music using ElevenLabs. '
            : '') +
          (p.videoProvider === 'runway'
            ? `AI-generated video using Runway. ${['openai', 'elevenlabs'].includes(p.narrationProvider) ? 'AI-generated speech, not a human voice.' : 'Test tone; no spoken narration.'} Human review required before release.`
            : ['openai', 'elevenlabs'].includes(p.narrationProvider)
              ? 'PREVIEW: development test visuals with AI-generated speech, not a human voice. Review before release.'
              : 'DEVELOPMENT PREVIEW: deterministic visuals and a test tone. Not finished AI footage or speech.'),
        status: 'ready',
      };
      const key = `${p.id}/${platform.replaceAll(' ', '-').toLowerCase()}-r${p.revision}.json`;
      await writePackage(key, {
        ...pack,
        files: {
          video: render.path,
          subtitles: subtitle.path,
          thumbnail: thumbnail.path,
        },
        aspect: p.aspect,
        manualReviewRequired: true,
      });
      const download = await assetFile(p, 'package', key, {
        revision: p.revision,
      });
      save('package', { ...pack, downloadAssetId: download.id });
    }
    transition(p, 'packaged');
  }
  signal.throwIfAborted();
  event(p.id, `${job.type}.completed`, { jobId: job.id });
}
