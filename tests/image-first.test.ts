import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project, Script } from '../shared/domain';
const dir = await mkdtemp(join(tmpdir(), 'cinema-image-first-'));
process.env.STUDIO_DATA_DIR = dir;
process.env.RUNWAY_API_KEY = 'test-only';
process.env.OPENAI_API_KEY = 'test-only';
const service = await import('../server/service');
const { base, db, save, get } = await import('../server/db');
const { conceptsFor, scenesFor, completeVideoPrompt } =
  await import('../server/creative');
const { claim, finish, JobDeferred } = await import('../server/queue');
const { handle } = await import('../server/handlers');
const { runwayTransport } = await import('../server/runway');
const { openaiTransport } = await import('../server/openai-client');
const { runProcess } = await import('../server/media');
const { config } = await import('../server/config');
const fixture = join(dir, 'clip.mp4'),
  imageFixture = join(dir, 'still.jpg');
await runProcess(config.FFMPEG_PATH, [
  '-y',
  '-f',
  'lavfi',
  '-i',
  'color=c=blue:s=720x1280:r=24:d=2',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-pix_fmt',
  'yuv420p',
  fixture,
]);
await runProcess(config.FFMPEG_PATH, [
  '-y',
  '-i',
  fixture,
  '-frames:v',
  '1',
  imageFixture,
]);
const video = await readFile(fixture),
  image = await readFile(imageFixture);
after(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});
const response = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
function prepared() {
  const p = service.createProject({
    title: 'The returning light',
    brief: 'A lone keeper watches a lighthouse beam across an empty sea.',
    duration: 6,
    mode: 'autonomous',
    videoProvider: 'runway',
    creativeProvider: 'openai',
    productionApproach: 'image_to_video',
    budget: { maximumRegenerationsPerScene: 0 },
  });
  const scenes = scenesFor(p, conceptsFor(p)[0]);
  for (const s of scenes) save('scene', s);
  save<Script>('script', {
    ...base(),
    projectId: p.id,
    title: p.title,
    hook: 'Light',
    ending: 'Hope',
    version: 1,
    estimatedDurationSeconds: 6,
    narration: scenes.map((s) => ({
      sceneNumber: s.sceneNumber,
      text: s.narration,
      start: s.startTime,
      end: s.endTime,
    })),
  });
  return save<Project>('project', { ...p, state: 'assets_planned' });
}
async function drain(id: string) {
  for (let i = 0; i < 30; i++) {
    db.prepare(
      "UPDATE jobs SET run_at=0 WHERE project_id=? AND status='queued'",
    ).run(id);
    const j = claim(180000);
    if (!j) return;
    try {
      await handle(j, new AbortController().signal);
      finish(j);
    } catch (e) {
      if (!(e instanceof JobDeferred)) throw e;
      finish(j, e);
    }
  }
  throw new Error('Jobs did not settle');
}
const plan = {
  referencePrompt:
    'One keeper in a yellow raincoat stands beside a red lighthouse door at blue dusk.',
  continuityNotes:
    'Same keeper and yellow raincoat, red door, blue dusk lighting. All movement goes left to right.',
  shots: [1, 2, 3].map((sceneNumber) => ({
    sceneNumber,
    imagePrompt: `@identity keeper at the red door at dusk, shot ${sceneNumber}, still composition.`,
    motionPrompt:
      'The keeper turns gently toward the sea. The camera holds steady.',
  })),
};
void test('image-first generates references, pauses for approvals, animates approved stills and gates assembly on clip review', async () => {
  let plans = 0,
    images = 0,
    videos = 0;
  const tasks = new Map<string, boolean>();
  openaiTransport.fetch = async () => {
    plans++;
    return response({
      status: 'completed',
      usage: { input_tokens: 100, output_tokens: 100 },
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(plan) }],
        },
      ],
    });
  };
  runwayTransport.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const isImage = url.endsWith('/text_to_image');
      if (isImage) {
        images++;
        assert.equal(body.model, 'gen4_image');
        assert.equal(body.ratio, '1080:1920');
        if (images > 1) {
          assert.equal(body.referenceImages[0].tag, 'identity');
          assert.match(
            body.referenceImages[0].uri,
            /^data:image\/jpeg;base64,/,
          );
        }
      } else {
        videos++;
        assert.ok(url.endsWith('/image_to_video'));
        assert.equal(body.promptText, plan.shots[0].motionPrompt);
        assert.match(body.promptImage, /^data:image\/jpeg;base64,/);
        assert.equal(body.duration, 2);
      }
      const id = randomUUID();
      tasks.set(id, isImage);
      return response({ id });
    }
    if (url.includes('/tasks/')) {
      const id = url.split('/').at(-1)!;
      return response({
        id,
        status: 'SUCCEEDED',
        cost: { credits: tasks.get(id) ? 8 : 24 },
        output: [
          `https://test.cloudfront.net/${tasks.get(id) ? 'still.jpg' : 'clip.mp4'}`,
        ],
      });
    }
    assert.equal(init?.headers, undefined);
    return new Response(url.endsWith('.jpg') ? image : video);
  };
  const p = prepared();
  service.startAutomation(p.id);
  assert.equal(get<Project>('project', p.id).automationRunning, false);
  assert.throws(() => service.requestStage(p.id, 'generate'), /Approve/);
  service.requestStage(p.id, 'visual_plan');
  await drain(p.id);
  assert.equal(plans, 1);
  assert.throws(
    () => service.requestStage(p.id, 'visual_plan'),
    /already exists/,
  );
  assert.throws(
    () => service.requestStage(p.id, 'storyboard_image'),
    /Approve/,
  );
  service.requestStage(p.id, 'reference_image');
  await drain(p.id);
  let d = service.detail(p.id);
  assert.equal(images, 1);
  assert.ok(d.project.referenceAssetId);
  assert.throws(
    () => service.approveVisual(p.id, undefined, { assetId: randomUUID() }),
    /changed/,
  );
  service.approveVisual(p.id, undefined, {
    assetId: d.project.referenceAssetId,
  });
  service.requestStage(p.id, 'storyboard_image');
  await drain(p.id);
  d = service.detail(p.id);
  assert.equal(images, 4);
  for (const s of d.scenes) {
    assert.ok(s.storyboardAssetId);
    service.approveVisual(p.id, s.id, { assetId: s.storyboardAssetId });
  }
  service.requestStage(p.id, 'generate');
  await drain(p.id);
  d = service.detail(p.id);
  assert.equal(videos, 3);
  assert.ok(d.scenes.every((s) => s.reviewFrameIds?.length === 3));
  assert.equal(d.project.reservedUsd, 0);
  assert.ok(Math.abs(d.project.spentUsd - 1.0402) < 1e-7);
  assert.throws(
    () => service.requestStage(p.id, 'narration'),
    /Watch and approve/,
  );
  service.startAutomation(p.id);
  assert.equal(get<Project>('project', p.id).automationRunning, false);
  for (const s of d.scenes) service.reviewScene(s.id, true);
  service.startAutomation(p.id);
  for (
    let i = 0;
    i < 8 && service.detail(p.id).project.state !== 'packaged';
    i++
  ) {
    await drain(p.id);
    service.advance(p.id);
  }
  assert.equal(service.detail(p.id).project.state, 'packaged');
  // A new still revision invalidates just its clip; the other approved clips survive.
  const before = service.detail(p.id);
  const previousStillJob = before.jobs.find(
    (j) => j.type === 'storyboard_image' && j.sceneId === before.scenes[0].id,
  )!;
  service.reviseVisual(p.id, before.scenes[0].id, {
    prompt: plan.shots[0].imagePrompt,
  });
  d = service.detail(p.id);
  await assert.rejects(
    handle(previousStillJob, new AbortController().signal),
    /older visual revision/,
  );
  assert.equal(d.scenes[0].assetId, undefined);
  assert.equal(d.scenes[0].storyboardAssetId, undefined);
  assert.equal(d.scenes[1].assetId, before.scenes[1].assetId);
  assert.equal(d.scenes[1].status, 'approved');
  assert.throws(() => service.requestStage(p.id, 'generate'), /Approve/);
  assert.throws(
    () =>
      service.approveVisual(p.id, d.scenes[0].id, {
        assetId: before.scenes[0].storyboardAssetId,
      }),
    /changed/,
  );
  service.reviseVisual(p.id, undefined, { prompt: plan.referencePrompt });
  d = service.detail(p.id);
  assert.equal(d.project.referenceApproved, false);
  assert.ok(d.scenes.every((s) => !s.storyboardAssetId && !s.assetId));
  assert.ok(d.assets.some((a) => a.type === 'render'));
  assert.equal(videos, 3);
  assert.equal(images, 4);
});
void test('whole prompts preserve essential action and camera instead of silently truncating', () => {
  const p = prepared(),
    s = service.detail(p.id).scenes[0];
  const long = {
    ...s,
    visualDescription: 'A'.repeat(990),
    cameraDirection: 'Pan gently left to right.',
  };
  const prompt = completeVideoPrompt(long, p.creativeBible);
  assert.ok(prompt.endsWith('Pan gently left to right.'));
  assert.ok(prompt.length > 1000);
});
void test('image budget and attempt ceilings stop purchases; uncertain image retry cannot purchase twice', async () => {
  const p = prepared();
  save('project', {
    ...p,
    referencePrompt: plan.referencePrompt,
    budget: { ...p.budget, maximumUsd: 0.01 },
  });
  assert.throws(() => service.requestStage(p.id, 'reference_image'), /budget/);
  save('project', { ...get<Project>('project', p.id), budget: p.budget });
  service.requestStage(p.id, 'reference_image');
  const j = claim(180000)!;
  let calls = 0;
  runwayTransport.fetch = async () => {
    calls++;
    throw new Error('Connection lost');
  };
  await assert.rejects(handle(j, new AbortController().signal), /unknown/);
  await assert.rejects(handle(j, new AbortController().signal), /unknown/);
  assert.equal(calls, 1);
  assert.equal(get<Project>('project', p.id).reservedUsd, 0.08);
  finish(j, new Error('test completed'));
  db.prepare("UPDATE jobs SET status='failed' WHERE project_id=?").run(p.id);
});

void test('image download recovery retrieves the saved task and settles only once', async () => {
  const p = prepared();
  save('project', { ...p, referencePrompt: plan.referencePrompt });
  service.requestStage(p.id, 'reference_image');
  const job = claim(180000)!;
  let posts = 0,
    downloads = 0;
  const id = randomUUID();
  runwayTransport.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      posts++;
      return response({ id });
    }
    if (url.includes('/tasks/'))
      return response({
        id,
        status: 'SUCCEEDED',
        cost: { credits: 8 },
        output: ['https://test.cloudfront.net/image.jpg'],
      });
    if (++downloads === 1) throw new Error('download interrupted');
    return new Response(image);
  };
  await assert.rejects(handle(job, new AbortController().signal), JobDeferred);
  await assert.rejects(
    handle(job, new AbortController().signal),
    /download interrupted/,
  );
  await handle(job, new AbortController().signal);
  await handle(job, new AbortController().signal);
  assert.equal(posts, 1);
  assert.equal(downloads, 2);
  assert.equal(get<Project>('project', p.id).spentUsd, 0.08);
  assert.equal(get<Project>('project', p.id).reservedUsd, 0);
  assert.ok(get<Project>('project', p.id).referenceAssetId);
  finish(job);
});
