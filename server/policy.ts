import type { State, Scene, Project, ProviderInfo } from '../shared/domain';
export class DomainError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
const transitions: Partial<Record<State, State[]>> = {
  idea: ['researching', 'concept_selected'],
  researching: ['concept_selected'],
  concept_selected: ['script_drafting'],
  script_drafting: ['storyboarding'],
  storyboarding: ['assets_planned'],
  assets_planned: ['generating'],
  generating: ['assembling', 'revision_required'],
  assembling: ['evaluating'],
  evaluating: ['approved', 'revision_required'],
  revision_required: ['generating', 'assembling', 'evaluating'],
  approved: ['packaged', 'generating'],
  packaged: ['scheduled', 'generating'],
  scheduled: ['published'],
  published: ['performance_tracking'],
  performance_tracking: ['archived'],
  failed: ['idea'],
};
export function canTransition(from: State, to: State) {
  return (
    from === to ||
    to === 'failed' ||
    to === 'archived' ||
    Boolean(transitions[from]?.includes(to))
  );
}
export function assertTransition(from: State, to: State) {
  if (!canTransition(from, to))
    throw new DomainError(`Cannot move from ${from} to ${to}`);
}
export function scoreConcept(criteria: Record<string, number>) {
  const weights: Record<string, number> = {
    hook: 2,
    emotion: 1.5,
    novelty: 1.3,
    clarity: 1.5,
    feasibility: 1.4,
    retention: 1.8,
  };
  let n = 0,
    d = 0;
  for (const [k, w] of Object.entries(weights)) {
    const v = criteria[k];
    if (!Number.isFinite(v) || v < 0 || v > 100)
      throw new DomainError(`Invalid score: ${k}`, 400);
    n += v * w;
    d += w;
  }
  return Math.round(n / d);
}
export function checkBudget(p: Project, cost: number, sceneAttempts: number) {
  if (!Number.isFinite(cost) || cost < 0)
    throw new DomainError('Invalid generation estimate');
  if (p.spentUsd + p.reservedUsd + cost > p.budget.maximumUsd + 1e-8)
    throw new DomainError('Project budget would be exceeded');
  if (p.generationAttempts >= p.budget.maximumTotalGenerationAttempts)
    throw new DomainError('Total generation attempt limit reached');
  if (sceneAttempts > p.budget.maximumRegenerationsPerScene)
    throw new DomainError('Scene regeneration limit reached');
}
export const retryDelay = (attempt: number) =>
  Math.min(60000, 1000 * 2 ** Math.max(0, attempt - 1));
export function selectVideoProvider(
  scene: Pick<Scene, 'durationSeconds'>,
  p: Pick<Project, 'aspect'>,
  providers: ProviderInfo[],
) {
  const eligible = providers
    .filter(
      (x) =>
        x.status === 'connected' &&
        x.capabilities.textToVideo &&
        x.capabilities.maximumDurationSeconds >= scene.durationSeconds &&
        x.capabilities.supportedAspectRatios.includes(p.aspect),
    )
    .sort((a, b) => a.costPerSecond - b.costPerSecond);
  if (!eligible.length)
    throw new DomainError('No available video provider supports this scene');
  return eligible[0];
}
export function contentValue(
  metrics: {
    completion: number;
    sharesPerView: number;
    savesPerView: number;
    watchRatio: number;
  },
  weights = { completion: 0.35, shares: 0.25, saves: 0.25, watch: 0.15 },
) {
  return Math.round(
    100 *
      (Math.min(1, Math.max(0, metrics.completion)) * weights.completion +
        Math.min(1, Math.max(0, metrics.sharesPerView) * 20) * weights.shares +
        Math.min(1, Math.max(0, metrics.savesPerView) * 20) * weights.saves +
        Math.min(1, Math.max(0, metrics.watchRatio)) * weights.watch),
  );
}
