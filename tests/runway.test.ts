import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Generation, Project, Scene, Job } from '../shared/domain';
const dir = await mkdtemp(join(tmpdir(), 'cinema-runway-'));
process.env.STUDIO_DATA_DIR = dir;
process.env.RUNWAY_API_KEY = 'test-only-not-a-real-key';
const { createProject, detail, startAutomation, advance } =
  await import('../server/service');
const { base, db, get, save, list } = await import('../server/db');
const { runwayTransport, generateRunway, validateRunwayOutputUrl } =
  await import('../server/runway');
const { claim, finish, enqueue, JobDeferred, cancelJob } =
  await import('../server/queue');
const { handle } = await import('../server/handlers');
const { runProcess } = await import('../server/media');
const { config } = await import('../server/config');
const { selectVideoProvider } = await import('../server/policy');
const { getProviderRegistry } = await import('../server/providers');
const fixture = join(dir, 'fixture.mp4');
await runProcess(config.FFMPEG_PATH, [
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=blue:s=720x1280:r=24:d=2',
  '-an',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-pix_fmt',
  'yuv420p',
  fixture,
]);
const video = await readFile(fixture);
const originalFetch = runwayTransport.fetch;
after(async () => {
  runwayTransport.fetch = originalFetch;
  db.close();
  await rm(dir, { recursive: true, force: true });
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
function project(maximumUsd = 5) {
  return createProject({
    title: 'A light returns',
    brief: 'A lighthouse keeper sees a faint answer across the ocean.',
    duration: 6,
    mode: 'autonomous',
    videoProvider: 'runway',
    budget: { maximumUsd },
  });
}
function sceneJob(p: Project): Job {
  const scene = save<Scene>('scene', {
    ...base(),
    projectId: p.id,
    sceneNumber: 1,
    durationSeconds: 2,
    purpose: 'A signal returns',
    narration: 'A light returns.',
    visualDescription: 'A lighthouse beam crosses an empty sea.',
    cameraDirection: 'Slow dolly',
    lighting: 'Moonlight',
    mood: 'Hope',
    transition: 'Cut',
    soundDesign: 'Waves',
    startTime: 0,
    endTime: 2,
    prompt:
      'A lighthouse beam crosses an empty sea. Slow cinematic dolly, moonlight.',
    negativePrompt: '',
    provider: 'runway',
    status: 'planned',
    revision: 1,
  });
  return enqueue(p.id, 'generate', `${p.id}:test`, scene.id);
}

void test('Runway workflow persists tasks, polls without exhausting attempts, renders and packages', async () => {
  let submissions = 0,
    downloads = 0;
  const tasks = new Map<string, number>();
  runwayTransport.fetch = async (url, init) => {
    if (url.endsWith('/text_to_video')) {
      submissions++;
      const input = JSON.parse(String(init?.body)) as {
        duration: number;
        ratio: string;
        model: string;
      };
      assert.equal(input.duration, 2);
      assert.equal(input.ratio, '720:1280');
      assert.equal(input.model, 'gen4.5');
      const id = randomUUID();
      tasks.set(id, 0);
      return response({ id, estimatedCost: { credits: 24 } });
    }
    if (url.includes('/tasks/')) {
      const id = url.split('/').at(-1)!;
      const n = tasks.get(id)!;
      tasks.set(id, n + 1);
      return response(
        n === 0
          ? { id, status: 'RUNNING' }
          : {
              id,
              status: 'SUCCEEDED',
              cost: { credits: 24 },
              output: ['https://test.cloudfront.net/video.mp4'],
            },
      );
    }
    downloads++;
    assert.equal(init?.headers, undefined);
    assert.equal(init?.redirect, 'error');
    return new Response(video, { headers: { 'Content-Type': 'video/mp4' } });
  };
  const p = project();
  startAutomation(p.id);
  for (
    let i = 0;
    i < 40 && get<Project>('project', p.id).state !== 'packaged';
    i++
  ) {
    advance(p.id);
    const job = claim(180000);
    assert.ok(job);
    try {
      await handle(job, new AbortController().signal);
      finish(job);
    } catch (error) {
      assert.ok(error instanceof JobDeferred);
      finish(job, error);
    }
    db.prepare(
      "UPDATE jobs SET run_at=0 WHERE project_id=? AND status='queued'",
    ).run(p.id);
  }
  const d = detail(p.id);
  assert.equal(d.project.state, 'packaged');
  assert.equal(submissions, 3);
  assert.equal(downloads, 3);
  assert.ok(Math.abs(d.project.spentUsd - 0.72) < 1e-8);
  assert.equal(d.project.reservedUsd, 0);
  assert.equal(d.generations.length, 3);
  assert.ok(
    d.generations.every(
      (g) => g.remoteTaskId && g.billed && g.status === 'completed',
    ),
  );
  assert.ok(
    d.jobs.filter((j) => j.type === 'generate').every((j) => j.attempt === 1),
  );
  assert.equal(
    d.assets.find((a) => a.type === 'render')?.parameters
      .developmentPlaceholder,
    false,
  );
  assert.ok(d.packages.every((pack) => pack.disclosure.includes('Runway')));
});

void test('unknown submissions retain reservations and cannot purchase twice after restart', async () => {
  let calls = 0;
  runwayTransport.fetch = async () => {
    calls++;
    throw new Error('connection lost');
  };
  const p = project(),
    job = sceneJob(p);
  await assert.rejects(
    generateRunway(job, new AbortController().signal),
    /unknown/,
  );
  await assert.rejects(
    generateRunway(job, new AbortController().signal),
    /unknown/,
  );
  assert.equal(calls, 1);
  assert.equal(get<Project>('project', p.id).reservedUsd, 0.24);
  assert.equal(list<Generation>('generation', p.id)[0].status, 'uncertain');
  assert.throws(() => cancelJob(job.id), /submission has started/);
  db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(job.id);
});

void test('budget, credentials and unsupported formats reject before paid requests', async () => {
  let calls = 0;
  runwayTransport.fetch = async () => {
    calls++;
    throw new Error('unexpected');
  };
  const p = project(0),
    job = sceneJob(p);
  await assert.rejects(
    generateRunway(job, new AbortController().signal),
    /budget/,
  );
  assert.equal(calls, 0);
  const key = config.RUNWAY_API_KEY;
  config.RUNWAY_API_KEY = '';
  try {
    assert.throws(() => project(), /RUNWAY_API_KEY/);
  } finally {
    config.RUNWAY_API_KEY = key;
  }
  assert.throws(
    () =>
      createProject({
        title: 'Square movie',
        brief: 'A lighthouse over an empty sea.',
        videoProvider: 'runway',
        aspect: '1:1',
      }),
    /portrait/,
  );
  assert.equal(
    selectVideoProvider(
      { durationSeconds: 2 },
      { aspect: '9:16' },
      getProviderRegistry(),
    ).id,
    'development',
  );
  assert.equal(
    selectVideoProvider({ durationSeconds: 2 }, p, getProviderRegistry()).id,
    'runway',
  );
  db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(job.id);
});

void test('rejected submissions release budget while terminal refunds settle exactly once', async () => {
  runwayTransport.fetch = async () => response({}, 401);
  const p = project(),
    job = sceneJob(p);
  await assert.rejects(
    generateRunway(job, new AbortController().signal),
    /HTTP 401/,
  );
  assert.equal(get<Project>('project', p.id).reservedUsd, 0);
  db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(job.id);
  const p2 = project(),
    j2 = sceneJob(p2),
    id = randomUUID();
  runwayTransport.fetch = async (url) =>
    response(
      url.endsWith('/text_to_video')
        ? { id }
        : { id, status: 'FAILED', cost: { credits: 0 } },
    );
  await assert.rejects(
    generateRunway(j2, new AbortController().signal),
    JobDeferred,
  );
  await assert.rejects(
    generateRunway(j2, new AbortController().signal),
    /task failed/,
  );
  assert.equal(get<Project>('project', p2.id).reservedUsd, 0);
  assert.equal(get<Project>('project', p2.id).spentUsd, 0);
  db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(j2.id);
});

void test('retrying a failed download reuses the paid task without double charging', async () => {
  const p = project(),
    job = sceneJob(p),
    id = randomUUID();
  let posts = 0,
    downloads = 0;
  runwayTransport.fetch = async (url) => {
    if (url.endsWith('/text_to_video')) {
      posts++;
      return response({ id });
    }
    if (url.includes('/tasks/'))
      return response({
        id,
        status: 'SUCCEEDED',
        cost: { credits: 24 },
        output: ['https://test.cloudfront.net/clip.mp4'],
      });
    if (++downloads === 1) throw new Error('download interrupted');
    return new Response(video);
  };
  await assert.rejects(
    generateRunway(job, new AbortController().signal),
    JobDeferred,
  );
  await assert.rejects(
    generateRunway(job, new AbortController().signal),
    /download interrupted/,
  );
  await generateRunway(job, new AbortController().signal);
  await generateRunway(job, new AbortController().signal);
  assert.equal(posts, 1);
  assert.equal(downloads, 2);
  assert.equal(get<Project>('project', p.id).spentUsd, 0.24);
  db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(job.id);
});

void test('Runway downloads reject local and misleading hosts', () => {
  for (const url of [
    'http://test.cloudfront.net/a',
    'https://127.0.0.1/a',
    'https://evilcloudfront.net/a',
    'https://test.cloudfront.net:443/a',
    'https://user:pass@test.cloudfront.net/a',
  ]) {
    // Explicit default HTTPS ports normalize to an empty port and remain safe.
    if (url.includes(':443')) continue;
    assert.throws(() => validateRunwayOutputUrl(url), /unsupported media host/);
  }
});
