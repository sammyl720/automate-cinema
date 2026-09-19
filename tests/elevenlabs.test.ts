import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job, Project, Scene } from '../shared/domain';
const dir = await mkdtemp(join(tmpdir(), 'cinema-eleven-'));
process.env.STUDIO_DATA_DIR = dir;
process.env.ELEVENLABS_API_KEY = 'fixture-secret';
const { createProject, detail, requestStage } =
  await import('../server/service');
const { base, db, save } = await import('../server/db');
const { elevenLabsTransport } = await import('../server/openai-client');
const { generateMusic } = await import('../server/music');
const { spokenNarration } = await import('../server/narration');
const { mediaPath, prepareDir, runProcess, probe, assetFile, renderTimeline } =
  await import('../server/media');
const { config } = await import('../server/config');
after(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});
function project(budget = 5) {
  return createProject({
    title: 'Audio fixture',
    brief: 'A quiet journey from darkness into light.',
    duration: 6,
    narrationProvider: 'elevenlabs',
    musicProvider: 'elevenlabs',
    budget: { maximumUsd: budget },
  });
}
function job(p: Project, type: Job['type']): Job {
  return {
    ...base(),
    projectId: p.id,
    type,
    status: 'running',
    attempt: 1,
    maxAttempts: 3,
    runAt: 0,
    leaseUntil: 0,
    progress: 0,
    priority: 0,
    key: 'fixture',
    payload: {},
  };
}
const signal = new AbortController().signal;
void test('Eleven speech and music replay safely and render a mixed six-second film', async () => {
  const initial = project();
  const p = save('project', { ...initial, revision: 2 });
  await prepareDir(p.id);
  const fixture = `${p.id}/fixture.mp3`;
  await runProcess(
    config.FFMPEG_PATH,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=6',
      mediaPath(fixture),
    ],
    signal,
  );
  const bytes = await readFile(mediaPath(fixture));
  let requests = 0;
  elevenLabsTransport.fetch = async (url, init) => {
    requests++;
    assert.equal(
      (init.headers as Record<string, string>)['xi-api-key'],
      'fixture-secret',
    );
    const body = JSON.parse(String(init.body));
    if (url.includes('/music?')) {
      assert.equal(body.force_instrumental, true);
      assert.equal(body.music_length_ms, 6000);
    } else {
      assert.match(url, /text-to-speech\/JBFqnCBsd6RMkjVDRZzb/);
      assert.equal(body.model_id, 'eleven_multilingual_v2');
      assert.equal(body.voice_settings.stability, 0.5);
    }
    return new Response(bytes, { headers: { 'x-request-id': 'fixture-id' } });
  };
  const clip = `${p.id}/clip.mp4`;
  await runProcess(
    config.FFMPEG_PATH,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x90:r=24:d=6',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      mediaPath(clip),
    ],
    signal,
  );
  const asset = await assetFile(p, 'video', clip);
  const scene: Scene = {
    ...base(),
    projectId: p.id,
    sceneNumber: 1,
    durationSeconds: 6,
    purpose: 'A reveal',
    narration: 'The light returns.',
    visualDescription: 'Light over a quiet ocean',
    cameraDirection: 'Still',
    lighting: 'Soft',
    mood: 'Hope',
    transition: 'Cut',
    soundDesign: 'Music',
    startTime: 0,
    endTime: 6,
    prompt: 'Ocean',
    negativePrompt: '',
    provider: 'development',
    status: 'generated',
    revision: 1,
    assetId: asset.id,
  };
  save('scene', scene);
  save('project', { ...p, state: 'generating' });
  const speech = job(p, 'narration');
  const music = job(p, 'music');
  await spokenNarration(p, speech, signal);
  assert.throws(() => requestStage(p.id, 'render'), /music track/);
  await generateMusic(p, music, signal);
  await spokenNarration(p, speech, signal);
  await generateMusic(p, music, signal);
  assert.equal(requests, 2);
  const d = detail(p.id);
  assert.equal(d.project.reservedUsd, 0);
  assert.ok(d.project.spentUsd > 0);
  assert.ok(!JSON.stringify(d).includes('fixture-secret'));
  await renderTimeline(p, [scene], d.assets, signal);
  const render = detail(p.id).assets.find((a) => a.type === 'render')!;
  const info = await probe(mediaPath(render.path), signal);
  assert.ok(info.streams.some((s) => s.codec_type === 'audio'));
  assert.ok(Math.abs(Number(info.format.duration) - 6) < 0.1);
  assert.equal(render.parameters.musicDucking, true);
});
void test('budget blocks music before a request and uncertain requests cannot repurchase', async () => {
  let requests = 0;
  elevenLabsTransport.fetch = async () => {
    requests++;
    throw new Error('network lost');
  };
  const empty = project(0);
  await assert.rejects(
    () => generateMusic(empty, job(empty, 'music'), signal),
    /budget/i,
  );
  assert.equal(requests, 0);
  const p = project();
  const j = job(p, 'music');
  await assert.rejects(() => generateMusic(p, j, signal), /interrupted/);
  await assert.rejects(() => generateMusic(p, j, signal), /uncertain outcome/);
  assert.equal(requests, 1);
  assert.ok(detail(p.id).project.reservedUsd > 0);
});
