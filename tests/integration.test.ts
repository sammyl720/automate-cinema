import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const dir = await mkdtemp(join(tmpdir(), 'cinema-test-'));
process.env.STUDIO_DATA_DIR = dir;
const {
  createProject,
  selectConcept,
  requestStage,
  startAutomation,
  detail,
  regenerate,
  editScene,
} = await import('../server/service');
const { db, jobs, get, save, list } = await import('../server/db');
const { enqueue, claim, finish, cancelJob, retryJob } =
  await import('../server/queue');
const { handle } = await import('../server/handlers');
const { startWorker } = await import('../server/worker');
const { createApi } = await import('../server/index');
const { constructPrompt } = await import('../server/creative');
const { probe, mediaPath, captionTime } = await import('../server/media');
const { unavailablePublisher } = await import('../server/providers');
import type { Project } from '../shared/domain';
const server = createApi();
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const addr = server.address();
if (!addr || typeof addr === 'string') throw new Error('No server address');
const url = `http://127.0.0.1:${addr.port}`;
let stop: undefined | (() => Promise<void>);
after(async () => {
  await stop?.();
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  await rm(dir, { recursive: true, force: true });
});
async function waitFor(id: string, state: string, timeout = 90000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const d = detail(id);
    if (
      d.project.state === state &&
      (!['assets_planned', 'packaged'].includes(state) ||
        !d.project.automationRunning) &&
      !d.jobs.some((j) => ['running', 'queued'].includes(j.status))
    )
      return d;
    if (d.project.error) throw new Error(d.project.error);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Timed out waiting for ${state}: ${JSON.stringify(detail(id).jobs)}`,
  );
}
void test('HTTP creation validates input, rejects cross-origin requests and returns persisted projects', async () => {
  const bad = await fetch(`${url}/api/projects`, {
    method: 'POST',
    body: '{"title":"x"}',
  });
  assert.equal(bad.status, 400);
  const cross = await fetch(`${url}/api/projects`, {
    method: 'POST',
    headers: { Origin: 'https://untrusted.example' },
    body: '{}',
  });
  assert.equal(cross.status, 403);
  const good = await fetch(`${url}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'API story',
      brief: 'A signal appears above a forgotten city.',
    }),
  });
  assert.equal(good.status, 201);
  const p = (await good.json()) as Project;
  assert.equal(get<Project>('project', p.id).title, 'API story');
  assert.equal((await fetch(`${url}/api/projects/${p.id}`)).status, 200);
});
void test('queue claims are exclusive, idempotent and recover expired leases', () => {
  const p = createProject({
    title: 'Queue story',
    brief: 'A light blinks twice above the water.',
  });
  const a = enqueue(p.id, 'concepts', 'unique-test');
  const b = enqueue(p.id, 'concepts', 'unique-test');
  assert.equal(a.id, b.id);
  const claimed = claim(1000)!;
  assert.equal(claimed.id, a.id);
  assert.equal(claim(1000), undefined);
  db.prepare('UPDATE jobs SET lease_until=? WHERE id=?').run(
    Date.now() - 1,
    a.id,
  );
  const recovered = claim(1000)!;
  assert.equal(recovered.id, a.id);
  assert.equal(recovered.attempt, 2);
  finish(recovered);
  assert.equal(jobs(p.id)[0].status, 'succeeded');
});
void test('failed provider calls back off, cancellation stops queue claims, retry budget is finite', () => {
  const p = createProject({
    title: 'Retry story',
    brief: 'A distant sound returns after a long silence.',
  });
  const j = enqueue(p.id, 'concepts', 'failure-test');
  const c = claim(1000)!;
  finish(c, new Error('Provider outage'));
  assert.equal(jobs(p.id)[0].status, 'queued');
  assert.ok(jobs(p.id)[0].runAt > Date.now());
  cancelJob(j.id);
  assert.equal(claim(1000), undefined);
  retryJob(j.id);
  const again = claim(1000)!;
  finish({ ...again, attempt: 3 }, new Error('Provider remains unavailable'));
  assert.equal(jobs(p.id)[0].status, 'failed');
  db.prepare('UPDATE jobs SET attempt=3 WHERE id=?').run(j.id);
  assert.throws(() => retryJob(j.id), /limit/);
});
void test('factual projects do not silently invent research', () => {
  const p = createProject({
    title: 'Saturn science',
    brief: 'A journey into the atmosphere of Saturn.',
    kind: 'factual',
  });
  assert.throws(() => startAutomation(p.id), /source/);
  assert.throws(() => requestStage(p.id, 'concepts'), /source/);
});
void test('prompt builder injects continuity and intentional cinematography', () => {
  const p = createProject({
    title: 'Prompt story',
    brief: 'A child follows a light into a quiet harbor.',
  });
  const prompt = constructPrompt(
    {
      visualDescription: 'A single light across a flooded harbor',
      cameraDirection: 'Slow dolly',
      lighting: 'Practical lamp',
      mood: 'hope',
      purpose: 'Reveal a surviving signal',
      durationSeconds: 3,
    },
    p.creativeBible,
  );
  assert.match(prompt, /Purpose: Reveal/);
  assert.match(prompt, /Consistent wardrobe/);
  assert.match(prompt, /Motivated camera: Slow dolly/);
  assert.equal(captionTime(61.25), '00:01:01,250');
});
void test('full autonomous flow renders a real platform-sized video and packages files', async () => {
  stop = startWorker();
  const p = createProject({
    title: 'Integration lighthouse',
    brief: 'The last keeper answers a tiny signal beyond the waves.',
    duration: 6,
    mode: 'autonomous',
  });
  startAutomation(p.id);
  const d = await waitFor(p.id, 'packaged');
  assert.equal(d.concepts.length, 3);
  assert.equal(d.scenes.length, 3);
  assert.ok(d.scenes.every((s) => Boolean(s.assetId)));
  assert.equal(d.packages.length, 3);
  assert.equal(d.generations.length, 3);
  assert.equal(d.project.spentUsd, 0);
  assert.ok(d.prompts.length >= 6);
  const render = d.assets.find((a) => a.type === 'render')!;
  const info = await probe(mediaPath(render.path));
  assert.ok(info.streams.some((s) => s.width === 1080 && s.height === 1920));
  assert.ok(info.streams.some((s) => s.codec_type === 'audio'));
  assert.equal(d.evaluations[0].metrics.creativeReviewPerformed, false);
  const response = await fetch(`${url}/media/${render.id}`, {
    headers: { Range: 'bytes=0-99' },
  });
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 100);
  const db2 = new DatabaseSync(join(dir, 'studio.sqlite'));
  assert.ok(db2.prepare('SELECT data FROM records WHERE id=?').get(p.id));
  db2.close();
  await assert.rejects(
    () =>
      unavailablePublisher.publish({
        projectId: p.id,
        packageId: d.packages[0].id,
        idempotencyKey: 'test',
      }),
    /unavailable/,
  );
  await stop();
  stop = undefined;
  const packageJob = d.jobs.find((j) => j.type === 'package')!;
  await handle(packageJob, new AbortController().signal);
  assert.equal(detail(p.id).packages.length, 3);
  save('project', {
    ...get<Project>('project', p.id),
    state: 'assets_planned',
  });
  await handle(
    d.jobs.find((j) => j.type === 'storyboard')!,
    new AbortController().signal,
  );
  assert.equal(detail(p.id).project.state, 'assets_planned');
  save('project', { ...get<Project>('project', p.id), state: 'approved' });
  await handle(
    d.jobs.find((j) => j.type === 'evaluate')!,
    new AbortController().signal,
  );
  assert.equal(detail(p.id).evaluations.length, 1);
  save('project', { ...get<Project>('project', p.id), state: 'packaged' });
  // Edits retain canonical narration history and invalidate stale delivery packages.
  editScene(d.scenes[0].id, {
    prompt: d.scenes[0].prompt + ' Hold the final frame.',
    narration: 'A new signal crosses the water.',
    provider: 'development',
  });
  const edited = detail(p.id);
  assert.equal(edited.packages.length, 0);
  assert.equal(edited.scenes[0].assetId, undefined);
  assert.equal(
    edited.scripts.at(-1)?.narration[0].text,
    'A new signal crosses the water.',
  );
  assert.ok(list('sceneRevision', p.id).length);
  requestStage(p.id, 'generate');
  stop = startWorker();
  await waitFor(p.id, 'generating');
  await stop();
  stop = undefined;
  const updated = detail(p.id);
  assert.equal(updated.generations.length, 4);
  const latest = updated.assets
    .filter((a) => a.sceneId === d.scenes[0].id)
    .at(-1)!;
  assert.ok(latest.parentAssetId);
  assert.equal(latest.revision, 2);
  // Bound regeneration counts before dispatching another expensive attempt.
  const project = get<Project>('project', p.id);
  save('project', {
    ...project,
    budget: { ...project.budget, maximumRegenerationsPerScene: 1 },
  });
  assert.throws(() => regenerate(d.scenes[0].id), /regeneration limit/);
  assert.equal(detail(p.id).scenes[0].assetId, latest.id);
});
void test('assisted automation waits before generation and manual mode waits before concept selection', async () => {
  stop = startWorker();
  const assisted = createProject({
    title: 'Assisted film',
    brief: 'A paper boat carries a message across an empty sea.',
    mode: 'assisted',
    duration: 6,
  });
  startAutomation(assisted.id);
  const d = await waitFor(assisted.id, 'assets_planned');
  assert.equal(d.project.generationAttempts, 0);
  assert.equal(d.project.automationRunning, false);
  const manual = createProject({
    title: 'Manual film',
    brief: 'An empty theatre lights up for one last visitor.',
    mode: 'manual',
  });
  startAutomation(manual.id);
  const until = Date.now() + 10000;
  while (Date.now() < until && detail(manual.id).concepts.length === 0)
    await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(detail(manual.id).project.selectedConceptId, undefined);
  await stop();
  stop = undefined;
  const concept = detail(manual.id).concepts[0];
  selectConcept(manual.id, concept.id);
  assert.equal(detail(manual.id).project.state, 'concept_selected');
});

void test('authenticated sessions gate API and media, and preserve Origin enforcement', async () => {
  const { config } = await import('../server/config');
  config.STUDIO_TOKEN = 'test-only-studio-token-with-at-least-32-characters';
  try {
    assert.equal((await fetch(`${url}/api/studio`)).status, 401);
    const login = await fetch(`${url}/api/session`, {
      method: 'POST',
      body: JSON.stringify({ token: config.STUDIO_TOKEN }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal(
      (
        await fetch(`${url}/api/studio`, {
          headers: { Cookie: cookie.split(';')[0] },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${url}/api/session`, {
          method: 'POST',
          body: JSON.stringify({ token: 'incorrect' }),
        })
      ).status,
      401,
    );
  } finally {
    config.STUDIO_TOKEN = '';
  }
});
void test('timed-out media subprocesses abort without blocking the worker', async () => {
  const { runProcess } = await import('../server/media');
  await assert.rejects(
    () =>
      runProcess(
        process.execPath,
        ['-e', 'setTimeout(()=>{},10000)'],
        AbortSignal.timeout(25),
      ),
    /abort/i,
  );
});
