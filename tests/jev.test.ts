import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job, Project, Scene } from '../shared/domain';
const dir = await mkdtemp(join(tmpdir(), 'cinema-jev-'));
process.env.STUDIO_DATA_DIR = dir;
process.env.TYPESAFE_API_KEY = 'typesafe-fixture-secret';
process.env.RUNWAY_API_KEY = 'runway-fixture-secret';
const { config } = await import('../server/config');
const { base, db, get, save, list, jobs } = await import('../server/db');
const {
  createProject,
  detail,
  startAutomation,
  requestStage,
  selectConcept,
  approvePreflight,
  editScene,
  regenerate,
} = await import('../server/service');
const { handle } = await import('../server/handlers');
const { conceptsFor, scenesFor } = await import('../server/creative');
const { scoreConcept } = await import('../server/policy');
const { normalizeJevScore, levels } = await import('../server/decision-policy');
const { assertPreflight, preflightDecisions } =
  await import('../server/decision-providers');
const { typesafeTransport, decisionKey } =
  await import('../server/typesafe-client');
const originalFetch = typesafeTransport.fetch;
after(async () => {
  typesafeTransport.fetch = originalFetch;
  db.close();
  await rm(dir, { recursive: true, force: true });
});
const signal = new AbortController().signal;
function project(
  mode: Project['mode'] = 'autonomous',
  extra: Record<string, unknown> = {},
) {
  return createProject({
    title: 'Jev test film',
    brief:
      'A lighthouse keeper receives an unexpected signal across a silent sea.',
    duration: 6,
    decisionProvider: 'jev',
    mode,
    ...extra,
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
    key: 'fixture',
    payload: {},
  };
}
let requests = 0;
function mock(
  confidence = 0.9,
  value = 3.8,
  options: { ambiguous?: boolean; unsupported?: boolean } = {},
) {
  requests = 0;
  typesafeTransport.fetch = async (url, init) => {
    requests++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(
      new Headers(init?.headers).get('authorization'),
      'Bearer typesafe-fixture-secret',
    );
    assert.ok(init?.signal);
    const b = JSON.parse(String(init?.body));
    assert.equal(b.model, 'jev-latest');
    // Generator self-grades must never influence the independent judge.
    assert.ok(!JSON.stringify(b.state).includes('generatorCriteria'));
    assert.ok(!JSON.stringify(b.state).includes('"criteria"'));
    const answers = Object.fromEntries(
      Object.entries(b.questions).map(([key, q]) => {
        if ((q as { type: string }).type === 'noul')
          return [
            key,
            {
              type: 'noul',
              noul:
                key === 'continuity'
                  ? 0.9
                  : key === 'ambiguity' && options.ambiguous
                    ? 0.8
                    : key === 'unsupportedClaim' && options.unsupported
                      ? 0.8
                      : 0.1,
            },
          ];
        const probabilities: Record<string, number> = {
          '0': 0,
          '1': 0,
          '2': 0,
          '3': 0,
          '4': 0,
        };
        probabilities[String(Math.floor(value))] = 1 - (value % 1);
        if (value % 1) probabilities[String(Math.ceil(value))] = value % 1;
        return [
          key,
          {
            type: 'score',
            score: value,
            confidence,
            probabilities,
            legend: Object.fromEntries(levels.map((x, i) => [i, x])),
          },
        ];
      }),
    );
    return new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers,
        usage: { input_tokens: 1000, output_tokens: 0 },
      }),
      { headers: { 'x-typesafe-request-id': 'jev-fixture' } },
    );
  };
}
async function evaluated(mode: Project['mode'] = 'autonomous') {
  const p = project(mode);
  await handle(job(p), signal);
  return get<Project>('project', p.id);
}
async function storyboard(
  mode: Project['mode'] = 'autonomous',
  extra: Record<string, unknown> = {},
) {
  const initial = project(mode, extra);
  const c = conceptsFor(initial)[0];
  save('concept', c);
  const p = save('project', {
    ...initial,
    selectedConceptId: c.id,
    state: 'assets_planned',
  } satisfies Project);
  for (const s of scenesFor(p, c)) save('scene', s);
  return p;
}
void test('normalization validates scale boundaries and expected scores', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4].map(normalizeJevScore),
    [0, 25, 50, 75, 100],
  );
  assert.equal(normalizeJevScore(3.21), 80);
  for (const value of [-1, 4.01, NaN, Infinity])
    assert.throws(() => normalizeJevScore(value));
});
void test('development and legacy projects work without TypeSafe credentials', async () => {
  const key = config.TYPESAFE_API_KEY;
  config.TYPESAFE_API_KEY = '';
  try {
    const p = createProject({
      title: 'Legacy film',
      brief: 'A quiet scene above a distant ocean.',
      mode: 'manual',
    });
    const legacy = { ...p };
    delete (legacy as Partial<Project>).decisionProvider;
    save('project', legacy);
    typesafeTransport.fetch = async () => {
      throw new Error('Must not call Jev');
    };
    await handle(job(p), signal);
    assert.equal(detail(p.id).concepts.length, 3);
    assert.equal(detail(p.id).apiCalls.length, 0);
    assert.throws(() => project(), /TYPESAFE_API_KEY/);
  } finally {
    config.TYPESAFE_API_KEY = key;
  }
});
void test('concepts preserve distributions, use existing weighting, and replay without paid calls', async () => {
  mock();
  const p = await evaluated('manual');
  const d = detail(p.id);
  assert.equal(d.decisions.length, 3);
  assert.equal(requests, 3);
  for (const c of d.concepts) {
    assert.equal(c.score, scoreConcept(c.criteria));
    assert.ok(c.generatorCriteria);
    assert.equal(c.criteria.hook, 95);
  }
  assert.equal(d.decisions[0].answers.hook.type, 'score');
  assert.deepEqual(
    (d.decisions[0].answers.hook as { probabilities: unknown }).probabilities,
    {
      '0': 0,
      '1': 0,
      '2': 0,
      '3': 0.20000000000000018,
      '4': 0.7999999999999998,
    },
  );
  assert.equal(d.decisions[0].model, 'jev-1.13.0');
  assert.equal(d.apiCalls[0].requestId, 'jev-fixture');
  await handle(job(p), signal);
  assert.equal(requests, 3);
  assert.equal(detail(p.id).project.reservedUsd, 0);
  assert.ok(!JSON.stringify(detail(p.id)).includes('typesafe-fixture-secret'));
});
void test('high-score high-confidence concepts may auto-select', async () => {
  mock();
  const p = await evaluated();
  startAutomation(p.id);
  const d = detail(p.id);
  assert.ok(d.project.selectedConceptId);
  assert.ok(d.jobs.some((j) => j.type === 'script'));
});
void test('high scores with low confidence pause for human selection', async () => {
  mock(0.4);
  const p = await evaluated();
  startAutomation(p.id);
  const d = detail(p.id);
  assert.equal(d.project.selectedConceptId, undefined);
  assert.match(d.project.error!, /confidence/);
  assert.equal(d.project.automationRunning, false);
  selectConcept(p.id, d.concepts[0].id);
  assert.equal(detail(p.id).project.selectedConceptId, d.concepts[0].id);
});
void test('confident low scores cannot auto-select', async () => {
  mock(0.95, 2);
  const p = await evaluated();
  startAutomation(p.id);
  assert.equal(detail(p.id).project.selectedConceptId, undefined);
  assert.match(detail(p.id).project.error!, /threshold/);
});
void test('manual mode waits and assisted mode can select eligible concepts', async () => {
  mock();
  const manual = await evaluated('manual');
  startAutomation(manual.id);
  assert.equal(detail(manual.id).project.selectedConceptId, undefined);
  const assisted = await evaluated('assisted');
  startAutomation(assisted.id);
  assert.ok(detail(assisted.id).project.selectedConceptId);
});
void test('provider errors never fall back and uncertain requests never automatically repurchase', async () => {
  requests = 0;
  typesafeTransport.fetch = async () => {
    requests++;
    throw new Error('Secret diagnostic typesafe-fixture-secret');
  };
  const p = project();
  const j = job(p);
  await assert.rejects(() => handle(j, signal), /interrupted/);
  await assert.rejects(() => handle(j, signal), /uncertain/);
  assert.equal(requests, 1);
  assert.ok(detail(p.id).project.reservedUsd > 0);
  startAutomation(p.id);
  assert.equal(detail(p.id).project.selectedConceptId, undefined);
  assert.ok(!JSON.stringify(detail(p.id)).includes('typesafe-fixture-secret'));
});
void test('HTTP rejection releases reservation while malformed judgments remain traceable without fallback', async () => {
  const p = project();
  const j = job(p);
  typesafeTransport.fetch = async () => new Response('secret', { status: 401 });
  await assert.rejects(() => handle(j, signal), /401/);
  assert.equal(detail(p.id).project.reservedUsd, 0);
  typesafeTransport.fetch = async () =>
    new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: { hook: { type: 'score', score: 100 } },
        usage: { input_tokens: 12, output_tokens: 0 },
      }),
    );
  await assert.rejects(() => handle(j, signal), /invalid judgment/);
  assert.equal(detail(p.id).apiCalls.at(-1)?.status, 'completed');
  assert.equal(detail(p.id).decisions.length, 0);
  await assert.rejects(() => handle(j, signal), /invalid judgment/);
});
void test('budget and pre-aborted signal block Jev before transport', async () => {
  mock();
  const p = project('manual', { budget: { maximumUsd: 0 } });
  await assert.rejects(() => handle(job(p), signal), /budget/);
  assert.equal(requests, 0);
  const other = project();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => handle(job(other), abort.signal));
  assert.equal(requests, 0);
});
void test('autonomous preflight blocks spending; explicit human review permits current storyboard only', async () => {
  mock(0.4);
  const p = await storyboard();
  await handle(job(p, 'preflight'), signal);
  assert.equal(preflightDecisions(p).length, 3);
  startAutomation(p.id);
  assert.equal(jobs(p.id).filter((j) => j.type === 'generate').length, 0);
  assert.match(detail(p.id).project.error!, /preflight requires human review/);
  assert.throws(() => requestStage(p.id, 'generate'), /human review/);
  await assert.rejects(
    () => handle(job(p, 'generate'), signal),
    /human review/,
  );
  approvePreflight(p.id, {
    note: 'Reviewed each shot and accepted the visual plan.',
  });
  assert.doesNotThrow(() => assertPreflight(get<Project>('project', p.id)));
  const scene = list<Scene>('scene', p.id)[0];
  editScene(scene.id, {
    prompt: scene.prompt + ' Revised composition.',
    narration: scene.narration,
    provider: 'development',
  });
  assert.throws(
    () => assertPreflight(get<Project>('project', p.id)),
    /current storyboard/,
  );
  assert.throws(
    () => approvePreflight(p.id, { note: 'An old approval must not apply.' }),
    /Complete/,
  );
});
void test('assisted preflight passes but still pauses at generation approval', async () => {
  mock();
  const p = await storyboard('assisted');
  await handle(job(p, 'preflight'), signal);
  startAutomation(p.id);
  assert.equal(detail(p.id).project.automationRunning, false);
  assert.equal(jobs(p.id).length, 0);
  requestStage(p.id, 'generate');
  assert.equal(jobs(p.id).filter((j) => j.type === 'generate').length, 3);
});
void test('missing preflight is queued before autonomous generation', async () => {
  mock();
  const p = await storyboard();
  startAutomation(p.id);
  assert.equal(jobs(p.id)[0].type, 'preflight');
  assert.equal(jobs(p.id).filter((j) => j.type === 'generate').length, 0);
});
void test('regeneration invalidates preflight instead of directly queueing paid work', async () => {
  mock();
  const p = await storyboard();
  await handle(job(p, 'preflight'), signal);
  const scene = list<Scene>('scene', p.id)[0];
  regenerate(scene.id);
  assert.equal(jobs(p.id).filter((j) => j.type === 'generate').length, 0);
  assert.throws(
    () => assertPreflight(get<Project>('project', p.id)),
    /current storyboard/,
  );
});
void test('factual evidence checks remain required and Jev flags unsupported assertions', async () => {
  mock(0.9, 3.8, { unsupported: true });
  const p = await storyboard('autonomous', { kind: 'factual' });
  assert.throws(() => startAutomation(p.id), /human-verified/);
  save('research', {
    ...base(),
    projectId: p.id,
    url: 'https://example.com/fact',
    fact: 'The light was restored in 1950.',
    verified: true,
    confidence: 1,
    notes: 'verified',
    accessedAt: new Date().toISOString(),
  });
  await handle(job(p, 'preflight'), signal);
  assert.throws(() => assertPreflight(p), /unsupportedClaim/);
});
void test('rubric versions, model and input changes cannot reuse stale cache keys', () => {
  const a = decisionKey('concept', 1, 'v1', {
    model: 'jev-latest',
    brief: 'A',
  });
  assert.notEqual(
    a,
    decisionKey('concept', 1, 'v2', { model: 'jev-latest', brief: 'A' }),
  );
  assert.notEqual(
    a,
    decisionKey('concept', 2, 'v1', { model: 'jev-latest', brief: 'A' }),
  );
  assert.notEqual(
    a,
    decisionKey('concept', 1, 'v1', { model: 'jev-1.13.0', brief: 'A' }),
  );
});

void test('SDK timeout and caller cancellation perform one request and retain reservations', async () => {
  const oldTimeout = config.TYPESAFE_TIMEOUT_MS;
  config.TYPESAFE_TIMEOUT_MS = 15;
  let calls = 0;
  typesafeTransport.fetch = async (_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener(
        'abort',
        () => reject(new Error('fixture transport aborted')),
        { once: true },
      );
    });
  };
  try {
    const p = project();
    const j = job(p);
    await assert.rejects(() => handle(j, signal), /interrupted/);
    await assert.rejects(() => handle(j, signal), /uncertain/);
    assert.equal(calls, 1);
    config.TYPESAFE_TIMEOUT_MS = 30000;
    const other = project();
    const controller = new AbortController();
    const pending = handle(job(other), controller.signal);
    setTimeout(() => controller.abort(), 15);
    await assert.rejects(() => pending, /interrupted/);
    assert.equal(calls, 2);
    assert.ok(detail(other.id).project.reservedUsd > 0);
  } finally {
    config.TYPESAFE_TIMEOUT_MS = oldTimeout;
  }
});
void test('strong probability gate applies independently of confidence and weighted score', async () => {
  mock(0.99, 3.8);
  const p = await evaluated();
  const d = detail(p.id).decisions[0];
  const a = d.answers.hook;
  if (a.type !== 'score') throw new Error('Expected score');
  a.score = 3.2;
  a.probabilities = { '0': 0, '1': 0, '2': 0.4, '3': 0, '4': 0.6 };
  save('decision', d);
  startAutomation(p.id);
  assert.equal(detail(p.id).project.selectedConceptId, undefined);
  assert.match(detail(p.id).project.error!, /P\(Strong/);
});
void test('changed storyboard inputs trigger a fresh preflight while identical replay is free', async () => {
  mock();
  const p = await storyboard();
  const j = job(p, 'preflight');
  await handle(j, signal);
  assert.equal(requests, 3);
  await handle(j, signal);
  assert.equal(requests, 3);
  const s = list<Scene>('scene', p.id)[0];
  save('scene', { ...s, prompt: s.prompt + ' A different angle.' });
  assert.throws(() => assertPreflight(p), /current storyboard/);
  await handle(job(p, 'preflight'), signal);
  assert.equal(requests, 6);
  assert.doesNotThrow(() => assertPreflight(p));
});

void test('committed raw calls reconstruct decision records after a persistence interruption', async () => {
  mock();
  const p = await evaluated('manual');
  const first = detail(p.id);
  for (const d of first.decisions)
    save('decision', { ...d, deletedAt: new Date().toISOString() });
  await handle(job(p), signal);
  assert.equal(requests, 3);
  assert.equal(detail(p.id).decisions.length, 3);
  assert.equal(detail(p.id).project.spentUsd, first.project.spentUsd);
});
void test('Jev preflight gates new Runway purchases but allows retrieval of an existing task', async () => {
  const { runwayTransport, generateRunway } = await import('../server/runway');
  const { JobDeferred } = await import('../server/queue');
  const original = runwayTransport.fetch;
  let lookups = 0;
  runwayTransport.fetch = async (url, init) => {
    assert.equal(init?.method, 'GET');
    assert.match(url, /tasks\/existing-task$/);
    lookups++;
    return new Response(
      JSON.stringify({ id: 'existing-task', status: 'RUNNING' }),
    );
  };
  try {
    const p = await storyboard('autonomous', { videoProvider: 'runway' });
    const scene = list<Scene>('scene', p.id)[0];
    const j = { ...job(p, 'generate'), sceneId: scene.id };
    await assert.rejects(() => generateRunway(j, signal), /preflight/);
    assert.equal(lookups, 0);
    save('generation', {
      ...base(),
      projectId: p.id,
      sceneId: scene.id,
      jobId: j.id,
      provider: 'runway',
      model: 'gen4.5',
      requestId: j.key,
      prompt: scene.prompt,
      attempt: 1,
      estimatedUsd: 0.24,
      actualUsd: 0,
      status: 'submitted',
      remoteTaskId: 'existing-task',
    });
    await assert.rejects(() => handle(j, signal), JobDeferred);
    assert.equal(lookups, 1);
  } finally {
    runwayTransport.fetch = original;
  }
});
