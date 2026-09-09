import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
const dir = await mkdtemp(join(tmpdir(), 'cinema-openai-'));
process.env.STUDIO_DATA_DIR = dir;
process.env.OPENAI_API_KEY = 'test-only-not-a-real-key';
const { config } = await import('../server/config');
const { createProject, detail } = await import('../server/service');
const { base, db, get, list, save } = await import('../server/db');
const { openaiTransport, structuredCall, textCost } =
  await import('../server/openai-client');
const { creativeProviders, scriptSchema } =
  await import('../server/creative-providers');
const { spokenNarration } = await import('../server/narration');
const { mediaPath, probe, prepareDir, runProcess } =
  await import('../server/media');
const { handle } = await import('../server/handlers');
import type { Project, Job, ApiCall, Scene } from '../shared/domain';
const originalFetch = openaiTransport.fetch;
after(async () => {
  openaiTransport.fetch = originalFetch;
  db.close();
  await rm(dir, { recursive: true, force: true });
});
function project(budget = 5) {
  return createProject({
    title: 'A signal in the rain',
    brief: 'A keeper sees a faint light return from an empty sea.',
    duration: 6,
    creativeProvider: 'openai',
    narrationProvider: 'openai',
    budget: {
      maximumUsd: budget,
      maximumRegenerationsPerScene: 2,
      maximumTotalGenerationAttempts: 20,
    },
  });
}
function job(p: Project, type: Job['type'] = 'concepts'): Job {
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
    key: 'test',
    payload: {},
  };
}
function envelope(value: unknown) {
  return new Response(
    JSON.stringify({
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(value) }],
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 20 },
      },
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'req_fixture',
      },
    },
  );
}
const schema = z.object({ title: z.string() });
void test('structured API call persists cost and reuses paid result on replay', async () => {
  const p = project();
  const j = job(p);
  let requests = 0;
  openaiTransport.fetch = async (url, init) => {
    requests++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init.body));
    assert.equal(body.text.format.strict, true);
    assert.equal(body.store, false);
    return envelope({ title: 'A signal returns' });
  };
  const a = await structuredCall(
    j,
    'test',
    'Write a title',
    { brief: p.brief },
    schema,
    new AbortController().signal,
  );
  assert.equal(a.title, 'A signal returns');
  await structuredCall(
    j,
    'test',
    'Write a title',
    { brief: p.brief },
    schema,
    new AbortController().signal,
  );
  assert.equal(requests, 1);
  const d = detail(p.id);
  assert.equal(d.apiCalls.length, 1);
  assert.equal(d.project.reservedUsd, 0);
  assert.ok(d.project.spentUsd > 0);
  assert.equal(d.apiCalls[0].requestId, 'req_fixture');
  assert.equal(JSON.stringify(d).includes('test-only-not-a-real-key'), false);
});
void test('budget and missing credentials reject before a network call', async () => {
  let requests = 0;
  openaiTransport.fetch = async () => {
    requests++;
    return envelope({ title: 'bad' });
  };
  const p = project(0);
  await assert.rejects(
    () =>
      structuredCall(
        job(p),
        'test',
        'Write',
        {},
        schema,
        new AbortController().signal,
      ),
    /budget/,
  );
  assert.equal(requests, 0);
  const key = config.OPENAI_API_KEY;
  config.OPENAI_API_KEY = '';
  try {
    assert.throws(() => project(), /authentication/);
  } finally {
    config.OPENAI_API_KEY = key;
  }
});
void test('unknown network outcomes retain reservations and block duplicate paid requests', async () => {
  const p = project();
  const j = job(p);
  let requests = 0;
  openaiTransport.fetch = async () => {
    requests++;
    throw new Error('Network failed with sensitive provider response');
  };
  await assert.rejects(
    () =>
      structuredCall(
        j,
        'test',
        'Write',
        {},
        schema,
        new AbortController().signal,
      ),
    /interrupted/,
  );
  assert.ok(detail(p.id).project.reservedUsd > 0);
  await assert.rejects(
    () =>
      structuredCall(
        j,
        'test',
        'Write',
        {},
        schema,
        new AbortController().signal,
      ),
    /uncertain/,
  );
  assert.equal(requests, 1);
  assert.equal(
    JSON.stringify(detail(p.id)).includes('sensitive provider response'),
    false,
  );
});
void test('HTTP rejection releases reservation; malformed paid output remains charged', async () => {
  const p = project();
  openaiTransport.fetch = async () =>
    new Response('do not log this body', { status: 401 });
  await assert.rejects(
    () =>
      structuredCall(
        job(p),
        'test',
        'Write',
        {},
        schema,
        new AbortController().signal,
      ),
    /401/,
  );
  assert.equal(detail(p.id).project.reservedUsd, 0);
  openaiTransport.fetch = async () => envelope({ wrong: 'shape' });
  const j = job(p);
  await assert.rejects(
    () =>
      structuredCall(
        j,
        'test',
        'Write',
        {},
        schema,
        new AbortController().signal,
      ),
    /validation/,
  );
  assert.ok(detail(p.id).project.spentUsd > 0);
  assert.equal(detail(p.id).apiCalls.at(-1)?.status, 'completed');
});
void test('rate limits are retryable but server errors remain uncertain', async () => {
  const p = project();
  const j = job(p);
  openaiTransport.fetch = async () => new Response('', { status: 429 });
  await assert.rejects(
    () =>
      structuredCall(
        j,
        'test',
        'Write',
        {},
        schema,
        new AbortController().signal,
      ),
    /rate limit/,
  );
  assert.equal(detail(p.id).project.reservedUsd, 0);
  openaiTransport.fetch = async () => new Response('', { status: 500 });
  await assert.rejects(
    () =>
      structuredCall(
        j,
        'test',
        'Write',
        {},
        schema,
        new AbortController().signal,
      ),
    /server error/,
  );
  assert.equal(detail(p.id).apiCalls.at(-1)?.status, 'uncertain');
});
void test('rate calculation honors cached tokens and output usage', () => {
  assert.equal(
    textCost({
      input_tokens: 1000000,
      output_tokens: 1000000,
      input_tokens_details: { cached_tokens: 1000000 },
    }).usd,
    1.7,
  );
});
const sceneSpecs = [1, 2, 3].map((sceneNumber) => ({
  sceneNumber,
  durationSeconds: 2,
  purpose: 'Reveal a returning signal',
  narration: ['A light.', 'An answer.', 'Still here.'][sceneNumber - 1],
  visualDescription: 'One distant light crosses a dark ocean.',
  cameraDirection: 'Slow motivated dolly',
  lighting: 'Practical lantern',
  mood: 'Hope',
  transition: 'Cut',
  soundDesign: 'Quiet waves',
  sourceIds: [],
}));
void test('live creative pipeline validates concept scores, script duration and shot continuity', async () => {
  const p = project();
  const j = job(p);
  const concepts = [1, 2, 3].map((i) => ({
    title: `Signal ${i}`,
    premise: 'A keeper discovers that the signal has an answer.',
    hook: 'A light answers.',
    hookType: 'mystery',
    arc: ['Wait', 'Discover', 'Answer'],
    ending: 'The light returns.',
    emotionalTarget: 'hope',
    visualIdentity: 'Cold ocean and warm light',
    criteria: {
      hook: 90,
      emotion: 90,
      novelty: 85,
      clarity: 90,
      feasibility: 95,
      retention: 85,
    },
    explanation: 'Clear short visual arc.',
  }));
  openaiTransport.fetch = async () => envelope({ concepts });
  const c = await creativeProviders.openai.concepts(
    p,
    j,
    new AbortController().signal,
  );
  assert.equal(c.length, 3);
  assert.ok(c[0].score > 80);
  openaiTransport.fetch = async () => envelope({ scenes: sceneSpecs });
  const scenes = await creativeProviders.openai.script(
    p,
    c[0],
    job(p, 'script'),
    new AbortController().signal,
  );
  assert.equal(scenes[2].endTime, 6);
  assert.match(scenes[0].prompt, /Continuity/);
  openaiTransport.fetch = async () =>
    envelope({
      shots: sceneSpecs.map((s) => ({
        sceneNumber: s.sceneNumber,
        visualDescription: s.visualDescription,
        cameraDirection: 'Measured crane movement',
        lighting: s.lighting,
        mood: s.mood,
        transition: s.transition,
        soundDesign: s.soundDesign,
        negativePrompt: 'watermark',
      })),
    });
  const board = await creativeProviders.openai.storyboard(
    p,
    scenes,
    job(p, 'storyboard'),
    new AbortController().signal,
  );
  assert.match(board[0].prompt, /crane/);
  assert.equal(board[0].narration, scenes[0].narration);
  assert.equal(scriptSchema.safeParse({ scenes: [] }).success, false);
});
void test('speech is persisted, fitted per scene, captioned and not purchased on replay', async () => {
  const p = project();
  await prepareDir(p.id);
  const fixture = mediaPath(`${p.id}/fixture.wav`);
  await runProcess(config.FFMPEG_PATH, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=200:duration=1',
    '-ar',
    '24000',
    fixture,
  ]);
  const audio = await readFile(fixture);
  for (const spec of sceneSpecs)
    save('scene', {
      ...base(),
      ...spec,
      projectId: p.id,
      startTime: (spec.sceneNumber - 1) * 2,
      endTime: spec.sceneNumber * 2,
      prompt: 'test cinematic prompt',
      negativePrompt: '',
      provider: 'development',
      revision: 1,
      status: 'planned',
    } satisfies Scene);
  let requests = 0;
  openaiTransport.fetch = async (url) => {
    assert.ok(url.endsWith('/audio/speech'));
    requests++;
    return new Response(audio, {
      headers: {
        'Content-Type': 'audio/wav',
        'x-request-id': 'speech-fixture',
      },
    });
  };
  const j = job(p, 'narration');
  await spokenNarration(p, j, new AbortController().signal);
  await spokenNarration(p, j, new AbortController().signal);
  assert.equal(requests, 3);
  const d = detail(p.id);
  const narration = d.assets.find((a) => a.type === 'narration' && !a.sceneId)!;
  assert.equal(narration.parameters.isSpeech, true);
  const metadata = await probe(mediaPath(narration.path));
  assert.ok(Math.abs(Number(metadata.format.duration) - 6) < 0.05);
  assert.equal(d.project.reservedUsd, 0);
  assert.ok(d.assets.some((a) => a.type === 'subtitles'));
  assert.equal(d.apiCalls.filter((c) => c.status === 'completed').length, 3);
});
void test('stage transitions preserve newly charged spend', async () => {
  const p = project();
  save('project', { ...p, state: 'script_drafting' });
  for (const spec of sceneSpecs)
    save('scene', {
      ...base(),
      ...spec,
      projectId: p.id,
      startTime: (spec.sceneNumber - 1) * 2,
      endTime: spec.sceneNumber * 2,
      prompt: 'test cinematic prompt',
      negativePrompt: '',
      provider: 'development',
      revision: 1,
      status: 'planned',
    } satisfies Scene);
  openaiTransport.fetch = async () =>
    envelope({
      shots: sceneSpecs.map((s) => ({
        sceneNumber: s.sceneNumber,
        visualDescription: s.visualDescription,
        cameraDirection: s.cameraDirection,
        lighting: s.lighting,
        mood: s.mood,
        transition: s.transition,
        soundDesign: s.soundDesign,
        negativePrompt: 'watermark',
      })),
    });
  await handle(job(p, 'storyboard'), new AbortController().signal);
  assert.equal(get<Project>('project', p.id).state, 'assets_planned');
  assert.ok(get<Project>('project', p.id).spentUsd > 0);
  assert.equal(list<ApiCall>('apiCall', p.id).length, 1);
});
