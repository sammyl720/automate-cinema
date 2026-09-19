import { z } from 'zod';
import { base, get, list, save, event, jobs, transaction } from './db';
import { enqueue, isBusy } from './queue';
import {
  projectInput,
  type Project,
  type Concept,
  type Scene,
  type Script,
  type Asset,
  type Evaluation,
  type ResearchSource,
  type ProjectDetail,
  type JobType,
  type State,
  type PlatformPackage,
  type PromptExecution,
  type Generation,
  type ApiCall,
  type DecisionEvaluation,
} from '../shared/domain';
import {
  DomainError,
  assertTransition,
  checkBudget,
  selectVideoProvider,
} from './policy';
import { getProviderRegistry } from './providers';
import { requireRunway } from './runway';
import { requireElevenLabs, requireOpenAI } from './openai-client';
import { requireTypeSafe } from './typesafe-client';
import {
  assertPreflight,
  conceptDecision,
  preflightDecisions,
  preflightJobKey,
  conceptJobKey,
} from './decision-providers';
import { judgeDecision } from './decision-policy';
import { constructPrompt } from './creative';
export function createProject(input: unknown): Project {
  const data = projectInput.parse(input);
  if (data.decisionProvider === 'jev') requireTypeSafe();
  if (data.videoProvider === 'runway') {
    requireRunway();
    if (data.aspect === '1:1' || data.duration > 30)
      throw new DomainError(
        'Runway MVP supports 6–30 seconds in portrait or landscape.',
      );
  }
  if (data.creativeProvider === 'openai' || data.narrationProvider === 'openai')
    requireOpenAI();
  if (
    data.narrationProvider === 'elevenlabs' ||
    data.musicProvider === 'elevenlabs'
  )
    requireElevenLabs();
  return transaction(() => {
    const p = save('project', {
      ...base(),
      ...data,
      state: 'idea',
      automationRunning: false,
      publishingEnabled: false,
      spentUsd: 0,
      reservedUsd: 0,
      generationAttempts: 0,
      revision: 1,
      creativeBible: {
        palette: ['deep teal', 'silver', 'muted amber'],
        visualRules: [
          'Consistent wardrobe and subject identity',
          'Motivate every camera movement',
          'Preserve screen direction',
        ],
        characters: [],
      },
    } satisfies Project);
    event(p.id, 'project.created', { title: p.title, mode: p.mode });
    return p;
  });
}
export function transition(p: Project, state: State) {
  assertTransition(p.state, state);
  if (p.state !== state)
    event(p.id, 'workflow.transition', { from: p.state, to: state });
  // A user may pause while FFmpeg is running; completing a stage must preserve it.
  const fresh = get<Project>('project', p.id);
  return save('project', {
    ...fresh,
    selectedConceptId: p.selectedConceptId ?? fresh.selectedConceptId,
    automationRunning: fresh.automationRunning,
    state,
    error: undefined,
  });
}
export function detail(id: string): ProjectDetail {
  const p = get<Project>('project', id);
  const current =
    p.decisionProvider === 'jev'
      ? new Set([
          ...preflightDecisions(p)
            .filter(Boolean)
            .map((d) => d!.id),
          ...list<Concept>('concept', id).map((c) => conceptDecision(p, c)?.id),
        ])
      : new Set<string>();
  return {
    project: get<Project>('project', id),
    concepts: list<Concept>('concept', id),
    scripts: list<Script>('script', id),
    scenes: list<Scene>('scene', id).sort(
      (a, b) => a.sceneNumber - b.sceneNumber,
    ),
    assets: list<Asset>('asset', id),
    jobs: jobs(id),
    evaluations: list<Evaluation>('evaluation', id),
    events: list('event', id),
    packages: list<PlatformPackage>('package', id),
    research: list<ResearchSource>('research', id),
    prompts: list<PromptExecution>('prompt', id),
    generations: list<Generation>('generation', id),
    apiCalls: list<ApiCall>('apiCall', id),
    decisions: list<DecisionEvaluation>('decision', id).map((d) => ({
      ...d,
      ...judgeDecision(d.stage, d.answers),
      current: current.has(d.id),
    })),
  };
}
export function assertResearch(p: Project) {
  if (
    p.kind === 'factual' &&
    !list<ResearchSource>('research', p.id).some((s) => s.verified)
  )
    throw new DomainError(
      'Factual projects need a source and a human-verified fact before creative development. Automated verification is not connected.',
    );
}
export function selectConcept(projectId: string, conceptId: string) {
  const p = get<Project>('project', projectId);
  if (!['idea', 'researching', 'concept_selected'].includes(p.state))
    throw new DomainError('Concept selection is locked after scripting begins');
  const c = get<Concept>('concept', conceptId);
  if (c.projectId !== projectId)
    throw new DomainError('Concept belongs to a different project', 404);
  assertResearch(p);
  if (isBusy(projectId))
    throw new DomainError(
      'Wait for concept evaluation to finish before selecting.',
    );
  if (p.decisionProvider === 'jev' && !conceptDecision(p, c))
    throw new DomainError(
      'Jev evaluation is missing for this concept. Retry the concept job; generator scores cannot substitute.',
    );
  for (const existing of list<Concept>('concept', projectId))
    save('concept', { ...existing, selected: existing.id === conceptId });
  const updated = transition(
    { ...p, selectedConceptId: conceptId },
    'concept_selected',
  );
  event(projectId, 'concept.approved', { conceptId });
  return updated;
}
export function requestStage(projectId: string, type: JobType) {
  const p = get<Project>('project', projectId);
  if (isBusy(projectId))
    throw new DomainError('This project already has queued or running work');
  const d = detail(projectId);
  const allowed: Record<JobType, State[]> = {
    concepts: ['idea', 'researching'],
    script: ['concept_selected'],
    storyboard: ['script_drafting'],
    preflight: ['assets_planned', 'generating', 'revision_required'],
    generate: ['assets_planned', 'revision_required', 'generating'],
    narration: ['generating'],
    music: ['generating'],
    render: ['generating', 'revision_required', 'assembling'],
    evaluate: ['assembling', 'evaluating'],
    package: ['approved', 'packaged'],
  };
  if (!allowed[type].includes(p.state))
    throw new DomainError(`${type} cannot run while project is ${p.state}`);
  if (['concepts', 'script'].includes(type)) assertResearch(p);
  if (type === 'concepts' && d.concepts.length && p.decisionProvider !== 'jev')
    throw new DomainError('Concepts already exist; select a concept');
  if (type === 'script' && !p.selectedConceptId)
    throw new DomainError('Select a concept first');
  if (
    type === 'preflight' &&
    (p.decisionProvider !== 'jev' || !d.scenes.length)
  )
    throw new DomainError(
      'Jev preflight requires a storyboard and Jev decision provider.',
    );
  if (type === 'generate') {
    assertResearch(p);
    assertPreflight(p);
    if (!d.scenes.length) throw new DomainError('Create a storyboard first');
    const pending = d.scenes.filter((s) => !s.assetId);
    if (d.scenes.some((s) => s.status === 'rejected'))
      throw new DomainError('Regenerate rejected scenes before continuing');
    if (!pending.length)
      throw new DomainError('All scenes already have assets');
    const estimate = pending.reduce(
      (sum, s) =>
        sum +
        selectVideoProvider(s, p, getProviderRegistry()).costPerSecond *
          Math.ceil(s.durationSeconds),
      0,
    );
    checkBudget(p, estimate, 0);
    if (
      p.generationAttempts + pending.length >
      p.budget.maximumTotalGenerationAttempts
    )
      throw new DomainError('Total generation attempt limit would be exceeded');
    for (const s of pending)
      checkBudget(p, 0, d.generations.filter((g) => g.sceneId === s.id).length);
    transaction(() => {
      transition(p, 'generating');
      event(p.id, 'generation.estimated', {
        estimatedUsd: estimate,
        sceneCount: pending.length,
      });
      for (const s of pending)
        enqueue(p.id, 'generate', `${p.id}:scene:${s.id}:r${s.revision}`, s.id);
    });
    return;
  }
  if (
    ['render', 'narration', 'music'].includes(type) &&
    (!d.scenes.length ||
      d.scenes.some((s) => !s.assetId || s.status === 'rejected'))
  )
    throw new DomainError('All scenes must have accepted media');
  if (
    type === 'render' &&
    !d.assets.some(
      (a) => a.type === 'narration' && !a.sceneId && a.revision === p.revision,
    )
  )
    throw new DomainError('Generate the narration test track first');
  if (type === 'music' && p.musicProvider !== 'elevenlabs')
    throw new DomainError('Select a music provider when creating the project');
  if (
    type === 'render' &&
    p.musicProvider === 'elevenlabs' &&
    !d.assets.some((a) => a.type === 'music' && a.revision === p.revision)
  )
    throw new DomainError('Generate the music track first');
  enqueue(
    projectId,
    type,
    type === 'preflight'
      ? preflightJobKey(p)
      : type === 'concepts' && p.decisionProvider === 'jev'
        ? conceptJobKey(p)
        : `${projectId}:${type}:r${p.revision}`,
  );
}
export function startAutomation(projectId: string) {
  let p = get<Project>('project', projectId);
  assertResearch(p);
  p = save('project', { ...p, automationRunning: true, error: undefined });
  event(projectId, 'automation.started');
  advance(projectId);
  return p;
}
export function advance(id: string) {
  let p = get<Project>('project', id);
  if (!p.automationRunning || isBusy(id)) return;
  const d = detail(id);
  const latestJobs = new Map<string, (typeof d.jobs)[number]>();
  for (const job of d.jobs) {
    const target = `${job.type}:${job.sceneId ?? 'project'}`;
    if (!latestJobs.has(target)) latestJobs.set(target, job);
  }
  if (
    [...latestJobs.values()].some((j) =>
      ['failed', 'cancelled'].includes(j.status),
    )
  ) {
    save('project', {
      ...p,
      automationRunning: false,
      error:
        'A job failed or was cancelled. Inspect and retry it before resuming.',
    });
    return;
  }
  try {
    if (['idea', 'researching'].includes(p.state)) {
      if (!d.concepts.length) {
        requestStage(id, 'concepts');
        return;
      }
      if (p.mode === 'manual') {
        save('project', { ...p, automationRunning: false });
        return;
      }
      if (
        p.decisionProvider === 'jev' &&
        d.concepts.some((c) => !conceptDecision(p, c))
      )
        throw new DomainError(
          'Jev concept evaluation is incomplete. Retry the concept job before automatic selection.',
        );
      const best = [...d.concepts].sort((a, b) => b.score - a.score)[0];
      if (best.score < 80)
        throw new DomainError(
          'Concept score is below the automatic selection threshold',
        );
      if (p.decisionProvider === 'jev') {
        const result = judgeDecision(
          'concept',
          conceptDecision(p, best)!.answers,
        );
        if (!result.passed)
          throw new DomainError(
            `Jev requires human concept selection: ${result.reasons.join('; ')}`,
          );
      }
      p = selectConcept(id, best.id);
    }
    if (p.mode === 'manual') {
      save('project', { ...p, automationRunning: false });
      return;
    }
    if (p.state === 'concept_selected') requestStage(id, 'script');
    else if (p.state === 'script_drafting') requestStage(id, 'storyboard');
    else if (p.state === 'assets_planned') {
      if (p.decisionProvider === 'jev') {
        if (preflightDecisions(p).some((d) => !d)) {
          requestStage(id, 'preflight');
          return;
        }
        assertPreflight(p);
      }
      if (p.mode === 'assisted') {
        save('project', { ...p, automationRunning: false });
        event(id, 'approval.required', { stage: 'generation' });
        return;
      }
      requestStage(id, 'generate');
    } else if (p.state === 'generating') {
      if (d.scenes.some((s) => !s.assetId)) return;
      if (
        !d.assets.some(
          (a) =>
            a.type === 'narration' && !a.sceneId && a.revision === p.revision,
        )
      )
        requestStage(id, 'narration');
      else if (
        p.musicProvider === 'elevenlabs' &&
        !d.assets.some((a) => a.type === 'music' && a.revision === p.revision)
      )
        requestStage(id, 'music');
      else requestStage(id, 'render');
    } else if (p.state === 'assembling') requestStage(id, 'evaluate');
    else if (p.state === 'approved') requestStage(id, 'package');
    else if (p.state === 'packaged')
      save('project', { ...p, automationRunning: false });
    else if (p.state === 'revision_required')
      save('project', {
        ...p,
        automationRunning: false,
        error: 'Technical evaluation needs review before another render.',
      });
  } catch (e) {
    save('project', {
      ...get<Project>('project', id),
      automationRunning: false,
      error: e instanceof Error ? e.message : String(e),
    });
    event(id, 'automation.paused', {
      reason: e instanceof Error ? e.message : String(e),
    });
  }
}
export const sceneEdit = z.object({
  prompt: z.string().trim().min(10).max(8000),
  narration: z.string().max(3000),
  provider: z.enum(['development', 'runway']),
});
export function editScene(id: string, input: unknown) {
  const s = get<Scene>('scene', id);
  if (isBusy(s.projectId))
    throw new DomainError('Pause or finish active work before editing scenes');
  const data = sceneEdit.parse(input);
  const project = get<Project>('project', s.projectId);
  if (data.provider !== (project.videoProvider ?? 'development'))
    throw new DomainError(
      'Scene provider must match the project video provider.',
    );
  if (data.provider === 'runway' && data.prompt.length > 1000)
    throw new DomainError('Runway prompts must be at most 1,000 characters.');
  save('sceneRevision', {
    ...base(),
    projectId: s.projectId,
    sceneId: s.id,
    scene: s,
  });
  const p = get<Project>('project', s.projectId);
  invalidateOutput(p);
  const updated = save('scene', {
    ...s,
    ...data,
    revision: s.revision + 1,
    status: 'planned',
    assetId: undefined,
  } satisfies Scene);
  const current = list<Script>('script', p.id).at(-1);
  if (current)
    save('script', {
      ...current,
      ...base(),
      version: current.version + 1,
      narration: current.narration.map((n) =>
        n.sceneNumber === s.sceneNumber ? { ...n, text: data.narration } : n,
      ),
    });
  return updated;
}
export function invalidateOutput(p: Project) {
  for (const k of ['package', 'evaluation'])
    for (const r of list<{ id: string; createdAt: string; updatedAt: string }>(
      k,
      p.id,
    ))
      save(k, { ...r, deletedAt: new Date().toISOString() });
  save('project', {
    ...p,
    revision: p.revision + 1,
    state: 'generating',
    automationRunning: false,
  });
  event(p.id, 'output.invalidated', { reason: 'Scene revision changed' });
}
export function regenerate(id: string) {
  const s = get<Scene>('scene', id);
  if (isBusy(s.projectId))
    throw new DomainError('Finish current work before regenerating');
  const p = get<Project>('project', s.projectId);
  const provider = selectVideoProvider(s, p, getProviderRegistry());
  checkBudget(
    p,
    provider.costPerSecond * Math.ceil(s.durationSeconds),
    list<Generation>('generation', p.id).filter((g) => g.sceneId === s.id)
      .length,
  );
  invalidateOutput(p);
  save('sceneRevision', {
    ...base(),
    projectId: s.projectId,
    sceneId: s.id,
    scene: s,
  });
  const updated = save('scene', {
    ...s,
    revision: s.revision + 1,
    status: 'planned',
    assetId: undefined,
  } satisfies Scene);
  if (p.decisionProvider !== 'jev')
    enqueue(
      s.projectId,
      'generate',
      `${s.projectId}:scene:${id}:r${updated.revision}`,
      id,
    );
  event(s.projectId, 'scene.regeneration_requested', { sceneId: id });
}
export function reviewScene(id: string, approved: boolean) {
  const s = get<Scene>('scene', id);
  if (isBusy(s.projectId))
    throw new DomainError('Wait for active work before reviewing');
  if (!s.assetId) throw new DomainError('Scene has no generated asset');
  if (!approved) invalidateOutput(get<Project>('project', s.projectId));
  save('scene', { ...s, status: approved ? 'approved' : 'rejected' });
  event(s.projectId, approved ? 'scene.approved' : 'scene.rejected', {
    sceneId: id,
  });
}
export function updateBible(id: string, input: unknown) {
  const p = get<Project>('project', id);
  if (!['idea', 'researching', 'concept_selected'].includes(p.state))
    throw new DomainError('Creative bible is locked once scripting starts');
  const bible = z
    .object({
      palette: z.array(z.string().max(100)).max(12),
      visualRules: z.array(z.string().max(500)).max(20),
      characters: z.array(z.string().max(1000)).max(20),
    })
    .parse(input);
  return save('project', { ...p, creativeBible: bible });
}
export function refreshPrompt(s: Scene, p: Project) {
  return constructPrompt(s, p.creativeBible);
}

export function approvePreflight(id: string, input: unknown) {
  const { note } = z
    .object({ note: z.string().trim().min(10).max(1000) })
    .parse(input);
  const p = get<Project>('project', id);
  if (isBusy(id))
    throw new DomainError('Wait for active work before reviewing preflight.');
  if (
    p.decisionProvider !== 'jev' ||
    !['assets_planned', 'generating', 'revision_required'].includes(p.state)
  )
    throw new DomainError('No reviewable Jev preflight at this stage.');
  const decisions = preflightDecisions(p);
  if (!decisions.length || decisions.some((d) => !d))
    throw new DomainError(
      'Complete the current Jev preflight before human approval.',
    );
  transaction(() => {
    for (const d of decisions)
      save('decision', {
        ...d!,
        humanReview: { approvedAt: new Date().toISOString(), note },
      });
    event(id, 'preflight.human_approved', {
      decisionIds: decisions.map((d) => d!.id),
      note,
    });
    save('project', { ...p, error: undefined });
  });
}
