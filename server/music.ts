import { rename, stat, writeFile } from 'node:fs/promises';
import type { Asset, Job, Project } from '../shared/domain';
import { config } from './config';
import { list } from './db';
import { assetFile, mediaPath, prepareDir, probe } from './media';
import { boundedBody, paidCall } from './openai-client';
import { DomainError } from './policy';

export async function generateMusic(p: Project, job: Job, signal: AbortSignal) {
  if (p.musicProvider !== 'elevenlabs')
    throw new DomainError('No music provider selected');
  await prepareDir(p.id);
  const key = `${p.id}/music-r${p.revision}.mp3`;
  const prompt =
    p.musicPrompt?.trim() ||
    'Subtle cinematic instrumental score beneath spoken narration.';
  const estimate = (p.duration / 60) * config.ELEVENLABS_MUSIC_USD_PER_MINUTE;
  const { result, call } = await paidCall({
    provider: 'elevenlabs',
    job,
    stage: 'music',
    model: 'music_v2_5',
    endpoint: 'eleven-music',
    signal,
    estimatedUsd: estimate,
    pricingBasis:
      'Configured ElevenLabs music rate per minute; estimate, not invoice',
    body: {
      model_id: 'music_v2_5',
      prompt,
      music_length_ms: p.duration * 1000,
      force_instrumental: true,
    },
    decode: async (response) => {
      const bytes = await boundedBody(response, 30 * 1024 * 1024);
      await writeFile(mediaPath(`${key}.tmp`), bytes);
      await rename(mediaPath(`${key}.tmp`), mediaPath(key));
      return {
        result: { path: key },
        calculatedUsd: estimate,
        usage: { requestedSeconds: p.duration },
      };
    },
  });
  await stat(mediaPath(result.path)).catch(() => {
    throw new DomainError(
      'Paid music file is missing. Restore from backup; automatic repurchase is blocked.',
    );
  });
  const info = await probe(mediaPath(result.path), signal);
  const duration = Number(info.format.duration);
  if (
    !info.streams.some((s) => s.codec_type === 'audio') ||
    !Number.isFinite(duration) ||
    duration < p.duration - 0.5
  )
    throw new DomainError(
      'Music response is invalid or too short. Its cost is recorded; review the request before generating again.',
    );
  if (!list<Asset>('asset', p.id).some((a) => a.path === key))
    await assetFile(p, 'music', key, {
      mime: 'audio/mpeg',
      revision: p.revision,
      provider: 'elevenlabs',
      duration,
      costUsd: call.calculatedUsd,
      prompt,
      parameters: {
        model: 'music_v2_5',
        instrumental: true,
        callId: call.id,
        developmentPlaceholder: false,
      },
      license:
        'AI-generated music. Review your ElevenLabs plan and music terms before distribution.',
    });
}
