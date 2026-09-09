import { writeFile, rename, stat } from 'node:fs/promises';
import type { Asset, Job, Project, Scene } from '../shared/domain';
import { list } from './db';
import { config } from './config';
import {
  assetFile,
  mediaPath,
  prepareDir,
  probe,
  runProcess,
  subtitles,
} from './media';
import { DomainError } from './policy';
import { boundedBody, paidCall, rates, SPEECH_MODEL } from './openai-client';
export async function spokenNarration(
  p: Project,
  job: Job,
  signal: AbortSignal,
) {
  await prepareDir(p.id);
  const scenes = list<Scene>('scene', p.id).sort(
    (a, b) => a.sceneNumber - b.sceneNumber,
  );
  const audioPaths: string[] = [];
  const timings: { sceneNumber: number; start: number; end: number }[] = [];
  let totalCost = 0;
  for (const s of scenes) {
    const key = `${p.id}/speech-${s.id}-r${p.revision}.wav`;
    if (!s.narration.trim() || s.narration.length > 4096)
      throw new DomainError(
        'Spoken narration requires 1–4096 characters per scene. Edit the narration first.',
      );
    const estimate =
      (Array.from(s.narration).length * rates.speechCharacters) / 1e6;
    const { result, call } = await paidCall({
      job,
      stage: 'narration',
      sceneId: s.id,
      model: SPEECH_MODEL,
      endpoint: 'audio/speech',
      body: {
        model: SPEECH_MODEL,
        voice: p.voice ?? 'alloy',
        input: s.narration,
        response_format: 'wav',
      },
      estimatedUsd: estimate,
      signal,
      decode: async (response) => {
        const audio = await boundedBody(response, 20 * 1024 * 1024);
        const temp = mediaPath(`${key}.tmp`);
        await writeFile(temp, audio);
        await rename(temp, mediaPath(key));
        return {
          result: { path: key },
          calculatedUsd: estimate,
          usage: { characters: Array.from(s.narration).length },
        };
      },
    });
    await stat(mediaPath(result.path)).catch(() => {
      throw new DomainError(
        'Paid speech file is missing. Restore it from backup; it will not be silently purchased again.',
      );
    });
    totalCost += call.calculatedUsd;
    const raw = await probe(mediaPath(result.path), signal);
    const duration = Number(raw.format.duration);
    if (
      !raw.streams.some((x) => x.codec_type === 'audio') ||
      !Number.isFinite(duration) ||
      duration <= 0
    )
      throw new DomainError('Speech provider returned invalid audio.');
    const speed = Math.max(1, duration / s.durationSeconds);
    if (speed > 1.25)
      throw new DomainError(
        `Scene ${s.sceneNumber} speech is too long. Shorten its narration before creating another revision.`,
      );
    const fitKey = `${p.id}/speech-fit-${s.id}-r${p.revision}.wav`;
    await runProcess(
      config.FFMPEG_PATH,
      [
        '-y',
        '-i',
        mediaPath(result.path),
        '-af',
        `atempo=${speed.toFixed(6)},apad,atrim=duration=${s.durationSeconds},asetpts=PTS-STARTPTS`,
        '-ar',
        '48000',
        '-ac',
        '1',
        mediaPath(fitKey),
      ],
      signal,
    );
    audioPaths.push(fitKey);
    timings.push({
      sceneNumber: s.sceneNumber,
      start: s.startTime,
      end: s.startTime + Math.min(duration / speed, s.durationSeconds),
    });
    if (!list<Asset>('asset', p.id).some((a) => a.path === key))
      await assetFile(p, 'narration', key, {
        sceneId: s.id,
        provider: 'openai',
        duration,
        revision: p.revision,
        costUsd: call.calculatedUsd,
        prompt: s.narration,
        parameters: {
          isSpeech: true,
          role: 'scene-source',
          voice: p.voice ?? 'alloy',
          model: SPEECH_MODEL,
          callId: call.id,
        },
        license:
          'AI-generated voice. Disclose synthetic speech; review provider terms.',
      });
  }
  const key = `${p.id}/narration-r${p.revision}.wav`;
  await runProcess(
    config.FFMPEG_PATH,
    [
      '-y',
      ...audioPaths.flatMap((path) => ['-i', mediaPath(path)]),
      '-filter_complex',
      `${audioPaths.map((_, i) => `[${i}:a]`).join('')}concat=n=${audioPaths.length}:v=0:a=1[a]`,
      '-map',
      '[a]',
      '-c:a',
      'pcm_s16le',
      mediaPath(key),
    ],
    signal,
  );
  const existing = list<Asset>('asset', p.id).find((a) => a.path === key);
  if (!existing)
    await assetFile(p, 'narration', key, {
      provider: 'openai',
      duration: p.duration,
      revision: p.revision,
      costUsd: 0,
      prompt: scenes.map((s) => s.narration).join('\n'),
      parameters: {
        isSpeech: true,
        role: 'timeline',
        voice: p.voice ?? 'alloy',
        model: SPEECH_MODEL,
        sourceCostUsd: totalCost,
        timings,
        transcript: scenes.map((s) => s.narration).join(' '),
        timing: 'Scene-aligned speech; not word alignment',
      },
      license:
        'AI-generated voice. Disclose synthetic speech; review provider terms.',
    });
  await subtitles(
    p,
    scenes.map((s) => ({
      ...s,
      endTime: timings.find((t) => t.sceneNumber === s.sceneNumber)!.end,
    })),
  );
}
