import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition,
  checkBudget,
  scoreConcept,
  retryDelay,
  selectVideoProvider,
  contentValue,
} from '../server/policy';
import {
  projectInput,
  sceneOutput,
  type Project,
  type ProviderInfo,
} from '../shared/domain';
const p = {
  ...projectInput.parse({
    title: 'Test story',
    brief: 'A lighthouse waits for an answer.',
  }),
  spentUsd: 4,
  reservedUsd: 2,
  generationAttempts: 2,
} as Project;
void test('workflow does not skip acceptance or packaging gates', () => {
  assert.equal(canTransition('idea', 'published'), false);
  assert.equal(canTransition('evaluating', 'approved'), true);
  assert.equal(canTransition('generating', 'packaged'), false);
  assert.equal(canTransition('packaged', 'published'), false);
});
void test('normalized concept scoring validates all criteria', () => {
  assert.equal(
    scoreConcept({
      hook: 100,
      emotion: 100,
      novelty: 100,
      clarity: 100,
      feasibility: 100,
      retention: 100,
    }),
    100,
  );
  assert.throws(() => scoreConcept({ hook: 101 }));
  assert.throws(() => scoreConcept({ hook: NaN }));
});
void test('budget reservations count before generation and attempts remain bounded', () => {
  checkBudget(p, 14, 0);
  assert.throws(() => checkBudget(p, 14.01, 0), /budget/);
  assert.throws(() => checkBudget(p, 0, 3), /regeneration/);
  assert.throws(
    () => checkBudget({ ...p, generationAttempts: 20 }, 0, 0),
    /attempt/,
  );
  assert.throws(() => checkBudget(p, -1, 0));
});
void test('retry backoff increases and caps at 60 seconds', () => {
  assert.equal(retryDelay(1), 1000);
  assert.equal(retryDelay(3), 4000);
  assert.equal(retryDelay(50), 60000);
});
void test('routing excludes unsupported capabilities and disconnected vendors', () => {
  const provider = {
    id: 'development',
    status: 'connected',
    costPerSecond: 1,
    capabilities: {
      textToVideo: true,
      maximumDurationSeconds: 5,
      supportedAspectRatios: ['9:16'],
    },
  } as ProviderInfo;
  assert.equal(
    selectVideoProvider({ durationSeconds: 5 }, p, [provider]).id,
    'development',
  );
  assert.throws(() =>
    selectVideoProvider({ durationSeconds: 6 }, p, [provider]),
  );
  assert.throws(() =>
    selectVideoProvider({ durationSeconds: 5 }, p, [
      { ...provider, status: 'unsupported' },
    ]),
  );
});
void test('structured output rejects malformed scenes and project budgets', () => {
  assert.equal(sceneOutput.safeParse({ sceneNumber: 1 }).success, false);
  assert.equal(
    projectInput.safeParse({ title: 'x', brief: 'bad' }).success,
    false,
  );
  assert.equal(projectInput.safeParse({ ...p, duration: 1000 }).success, false);
});
void test('content value uses completion and meaningful engagement', () => {
  assert.equal(
    contentValue({
      completion: 1,
      sharesPerView: 0.05,
      savesPerView: 0.05,
      watchRatio: 1,
    }),
    100,
  );
  assert.equal(
    contentValue({
      completion: 0,
      sharesPerView: 0,
      savesPerView: 0,
      watchRatio: 0,
    }),
    0,
  );
});
