import { spawn } from 'node:child_process';
import { mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { config } from './config';
import { base, save } from './db';
import type { Asset, Project, Scene } from '../shared/domain';
export const mediaRoot = join(config.dataDir, 'media');
export function mediaPath(key: string) {
  const path = resolve(mediaRoot, key);
  if (!path.startsWith(resolve(mediaRoot) + sep))
    throw new Error('Invalid storage key');
  return path;
}
export async function runProcess(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    let out = '',
      err = '';
    child.stdout.on('data', (d) => {
      out = (out + d).slice(-1000000);
    });
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-8000);
    });
    child.on('error', rej);
    child.on('close', (code) =>
      code === 0
        ? res(out)
        : rej(new Error(`${command} exited ${code}: ${err.slice(-1500)}`)),
    );
  });
}
export async function probe(path: string, signal?: AbortSignal) {
  const raw = await runProcess(
    config.FFPROBE_PATH,
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
    signal,
  );
  return JSON.parse(raw) as {
    streams: { codec_type: string; width?: number; height?: number }[];
    format: { duration?: string; size?: string };
  };
}
export const dimensions = (
  aspect: Project['aspect'],
  quality: Project['quality'],
): [number, number] =>
  quality === 'final'
    ? aspect === '9:16'
      ? [1080, 1920]
      : aspect === '16:9'
        ? [1920, 1080]
        : [1080, 1080]
    : aspect === '9:16'
      ? [360, 640]
      : aspect === '16:9'
        ? [640, 360]
        : [360, 360];
export async function assetFile(
  p: Project,
  type: Asset['type'],
  key: string,
  extra: Partial<Asset> = {},
): Promise<Asset> {
  const info = await stat(mediaPath(key));
  return save('asset', {
    ...base(),
    projectId: p.id,
    type,
    path: key,
    mime:
      type === 'subtitles'
        ? 'text/plain'
        : type === 'thumbnail'
          ? 'image/jpeg'
          : type === 'package'
            ? 'application/json'
            : type === 'narration'
              ? 'audio/wav'
              : 'video/mp4',
    provider: 'development',
    prompt: '',
    parameters: { developmentPlaceholder: true },
    costUsd: 0,
    duration: 0,
    width: 0,
    height: 0,
    size: info.size,
    revision: 1,
    status: 'ready',
    license: 'Generated development test asset. No third-party media.',
    ...extra,
  } satisfies Asset);
}
export async function prepareDir(projectId: string) {
  await mkdir(mediaPath(projectId), { recursive: true });
}
export async function renderTimeline(
  p: Project,
  scenes: Scene[],
  assets: Asset[],
  signal?: AbortSignal,
) {
  await prepareDir(p.id);
  const ordered = [...scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
  const inputs = ordered.map((s) => {
    const asset = assets.find((a) => a.id === s.assetId);
    if (!asset) throw new Error(`Scene ${s.sceneNumber} is missing media`);
    return asset;
  });
  const key = `${p.id}/render-r${p.revision}.mp4`;
  const [w, h] = dimensions(p.aspect, 'final');
  const args = ['-y', ...inputs.flatMap((a) => ['-i', mediaPath(a.path)])];
  const narration = assets
    .filter(
      (a) => a.type === 'narration' && !a.sceneId && a.revision === p.revision,
    )
    .at(-1);
  if (narration) args.push('-i', mediaPath(narration.path));
  const music =
    p.musicProvider === 'elevenlabs'
      ? assets
          .filter((a) => a.type === 'music' && a.revision === p.revision)
          .at(-1)
      : undefined;
  if (music) args.push('-i', mediaPath(music.path));
  const filters = inputs
    .map(
      (_, i) =>
        `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=24,trim=duration=${ordered[i].durationSeconds},setpts=PTS-STARTPTS[v${i}]`,
    )
    .join(';');
  const audioFilters =
    narration && music
      ? `;[${inputs.length}:a]loudnorm=I=-16:TP=-2:LRA=11,aresample=48000,asplit[voice][side];[${inputs.length + 1}:a]loudnorm=I=-20:TP=-2:LRA=11,aresample=48000,volume=${p.musicVolumeDb ?? -12}dB,apad,atrim=duration=${p.duration},afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, p.duration - 1.5)}:d=1.5[bed];[bed][side]sidechaincompress=threshold=0.025:ratio=6:attack=20:release=300[ducked];[voice][ducked]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.89:level=false[outa]`
      : '';
  args.push(
    '-filter_complex',
    `${filters};${inputs.map((_, i) => `[v${i}]`).join('')}concat=n=${inputs.length}:v=1:a=0[outv]${audioFilters}`,
    '-map',
    '[outv]',
  );
  if (narration && music) args.push('-map', '[outa]', '-c:a', 'aac');
  else if (narration)
    args.push(
      '-map',
      `${inputs.length}:a:0`,
      '-af',
      'loudnorm=I=-16:TP=-1.5:LRA=11',
      '-c:a',
      'aac',
    );
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '24',
    '-pix_fmt',
    'yuv420p',
    '-t',
    String(p.duration),
    '-movflags',
    '+faststart',
    mediaPath(key),
  );
  await runProcess(config.FFMPEG_PATH, args, signal);
  const asset = await assetFile(p, 'render', key, {
    duration: p.duration,
    width: w,
    height: h,
    revision: p.revision,
    provider: 'ffmpeg',
    parameters: {
      sceneAssets: inputs.map((a) => a.id),
      narrationAsset: narration?.id,
      musicAsset: music?.id,
      musicVolumeDb: music ? (p.musicVolumeDb ?? -12) : undefined,
      musicDucking: Boolean(music),
      isSpeech: narration?.parameters.isSpeech === true,
      developmentPlaceholder: inputs.some(
        (a) => a.parameters.developmentPlaceholder !== false,
      ),
    },
  });
  const thumbKey = `${p.id}/thumbnail-r${p.revision}.jpg`;
  await runProcess(
    config.FFMPEG_PATH,
    [
      '-y',
      '-i',
      mediaPath(key),
      '-frames:v',
      '1',
      '-vf',
      'scale=360:-1',
      mediaPath(thumbKey),
    ],
    signal,
  );
  await assetFile(p, 'thumbnail', thumbKey, {
    revision: p.revision,
    provider: 'ffmpeg',
  });
  return asset;
}
export function captionTime(seconds: number, separator = ',') {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}`;
}
export async function subtitles(p: Project, scenes: Scene[]) {
  const ordered = [...scenes].sort((a, b) => a.sceneNumber - b.sceneNumber);
  for (const ext of ['srt', 'vtt']) {
    const key = `${p.id}/captions-r${p.revision}.${ext}`;
    const content =
      (ext === 'vtt' ? 'WEBVTT\n\n' : '') +
      ordered
        .map(
          (s, i) =>
            `${ext === 'srt' ? `${i + 1}\n` : ''}${captionTime(s.startTime, ext === 'vtt' ? '.' : ',')} --> ${captionTime(s.endTime, ext === 'vtt' ? '.' : ',')}\n${s.narration}\n`,
        )
        .join('\n');
    await writeFile(mediaPath(key), content);
    await assetFile(p, 'subtitles', key, {
      revision: p.revision,
      parameters: {
        timing: ['openai', 'elevenlabs'].includes(p.narrationProvider)
          ? 'Scene-level timing fitted to speech duration; not word-aligned'
          : 'scene-level canonical transcript; not speech-aligned',
      },
      mime: ext === 'vtt' ? 'text/vtt' : 'application/x-subrip',
    });
  }
}
export async function writePackage(key: string, value: unknown) {
  await writeFile(mediaPath(key), JSON.stringify(value, null, 2));
  return readFile(mediaPath(key));
}
