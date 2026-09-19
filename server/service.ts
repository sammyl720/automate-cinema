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
  if (
    data.productionApproach === 'image_to_video' &&
    (data.videoProvider !== 'runway' || data.creativeProvider !== 'openai')
  )
    throw new DomainError(
      'Image-first production requires Runway video and OpenAI creative planning.',
    );
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
export function assertScriptReady(p: Project) {
  const scenes = list<Scene>('scene', p.id).sort(
    (a, b) => a.sceneNumber - b.sceneNumber,
  );
  if (
    !list<Script>('script', p.id).length ||
    scenes.length !== 3 ||
    scenes.some((s, i) => s.sceneNumber !== i + 1 || s.durationSeconds <= 0) ||
    Math.abs(
      scenes.reduce((sum, s) => sum + s.durationSeconds, 0) - p.duration,
    ) > 0.05
  )
    throw new DomainError(
      'Complete the script successfully before building the storyboard. Retry the failed script job first.',
    );
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
    visual_plan: ['assets_planned', 'generating', 'revision_required'],
    reference_image: ['assets_planned', 'generating', 'revision_required'],
    storyboard_image: ['assets_planned', 'generating', 'revision_required'],
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
  if (type === 'storyboard') assertScriptReady(p);
  if (type === 'script' && !p.selectedConceptId)
    throw new DomainError('Select a concept first');
  if (
    type === 'preflight' &&
    (p.decisionProvider !== 'jev' || !d.scenes.length)
  )
    throw new DomainError(
      'Jev preflight requires a storyboard and Jev decision provider.',
    );
  if (['visual_plan', 'reference_image', 'storyboard_image'].includes(type)) {
    if (p.productionApproach !== 'image_to_video')
      throw new DomainError('Enable image-first production first.');
    assertScriptReady(p);
    if (type === 'visual_plan' && p.referencePrompt)
      throw new DomainError(
        'Visual plan already exists. Edit its prompts instead.',
      );
    if (type === 'reference_image') {
      if (!p.referencePrompt || p.referenceAssetId)
        throw new DomainError(
          'Create a visual plan or revise the existing reference first.',
        );
      checkBudget(
        p,
        0.08,
        d.generations.filter((g) => g.model === 'gen4_image' && !g.sceneId)
          .length,
      );
      enqueue(
        p.id,
        type,
        `${p.id}:reference:r${p.referenceRevision ?? 1}`,
        undefined,
        { visualRevision: p.referenceRevision ?? 1 },
      );
      return;
    }
    if (type === 'storyboard_image') {
      if (!p.referenceApproved || !p.referenceAssetId)
        throw new DomainError('Approve the shared visual reference first.');
      const pending = d.scenes.filter((s) => !s.storyboardAssetId);
      if (!pending.length)
        throw new DomainError('All storyboard images already exist.');
      checkBudget(p, pending.length * 0.08, 0);
      if (
        p.generationAttempts + pending.length >
        p.budget.maximumTotalGenerationAttempts
      )
        throw new DomainError(
          'Total generation attempt limit would be exceeded',
        );
      for (const s of pending) {
        if (!s.imagePrompt)
          throw new DomainError('Create a visual plan first.');
        checkBudget(
          p,
          0,
          d.generations.filter(
            (g) => g.sceneId === s.id && g.model === 'gen4_image',
          ).length,
        );
      }
      transaction(() => {
        for (const s of pending)
          enqueue(
            p.id,
            type,
            `${p.id}:still:${s.id}:r${s.storyboardRevision ?? 1}`,
            s.id,
            { visualRevision: s.storyboardRevision ?? 1 },
          );
      });
      return;
    }
  }
  if (type === 'generate') {
    assertVisualsReady(p, d.scenes);
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
      checkBudget(
        p,
        0,
        d.generations.filter(
          (g) => g.sceneId === s.id && g.model !== 'gen4_image',
        ).length,
      );
    transaction(() => {
      transition(p, 'generating');
      event(p.id, 'generation.estimated', {
        estimatedUsd: estimate,
        sceneCount: pending.length,
      });
      for (const s of pending)
        enqueue(
          p.id,
          'generate',
          `${p.id}:scene:${s.id}:r${s.revision}`,
          s.id,
          { sceneRevision: s.revision },
        );
    });
    return;
  }
  if (['render', 'narration', 'music'].includes(type))
    assertClipsReviewed(p, d.scenes);
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
  const blockingJob = [...latestJobs.values()].find((j) =>
    ['failed', 'cancelled'].includes(j.status),
  );
  if (blockingJob) {
    save('project', {
      ...p,
      automationRunning: false,
      error: `${blockingJob.type} job ${blockingJob.status}: ${blockingJob.error ?? 'No details available'}. Open Generations and retry this job before resuming.`,
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
    else if (
      p.productionApproach === 'image_to_video' &&
      ['assets_planned', 'generating', 'revision_required'].includes(p.state) &&
      (!p.referenceApproved || d.scenes.some((s) => !s.storyboardApproved))
    ) {
      save('project', { ...p, automationRunning: false, error: undefined });
      event(id, 'approval.required', { stage: 'visual_references' });
      return;
    } else if (p.state === 'assets_planned') {
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
        p.productionApproach === 'image_to_video' &&
        d.scenes.some((s) => s.status !== 'approved')
      ) {
        save('project', { ...p, automationRunning: false, error: undefined });
        event(id, 'approval.required', { stage: 'finished_clips' });
        return;
      }
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
    ...(p.productionApproach === 'image_to_video'
      ? { cameraDirection: data.prompt }
      : {}),
    revision: s.revision + 1,
    status: 'planned',
    assetId: undefined,
    reviewFrameIds: [],
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
    error: undefined,
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
    list<Generation>('generation', p.id).filter(
      (g) => g.sceneId === s.id && g.model !== 'gen4_image',
    ).length,
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
    reviewFrameIds: [],
  } satisfies Scene);
  if (p.decisionProvider !== 'jev' && p.productionApproach !== 'image_to_video')
    enqueue(
      s.projectId,
      'generate',
      `${s.projectId}:scene:${id}:r${updated.revision}`,
      id,
      { sceneRevision: updated.revision },
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

export function assertVisualsReady(p: Project, scenes: Scene[]) {
  if (
    p.productionApproach === 'image_to_video' &&
    (!p.referenceAssetId ||
      !p.referenceApproved ||
      scenes.length !== 3 ||
      scenes.some((s) => !s.storyboardAssetId || !s.storyboardApproved))
  )
    throw new DomainError(
      'Approve the shared reference and all three starting images before generating clips.',
    );
}
export function assertClipsReviewed(p: Project, scenes: Scene[]) {
  if (
    p.productionApproach === 'image_to_video' &&
    (scenes.length !== 3 ||
      scenes.some((s) => !s.assetId || s.status !== 'approved'))
  )
    throw new DomainError(
      'Watch and approve all three clips before narration, music or assembly.',
    );
}
export function enableImageFirst(id: string) {
  const p = get<Project>('project', id);
  if (isBusy(id)) throw new DomainError('Finish active jobs first.');
  if (p.videoProvider !== 'runway' || p.creativeProvider !== 'openai')
    throw new DomainError('Image-first production requires Runway and OpenAI.');
  if (p.productionApproach === 'image_to_video') return;
  if (
    ![
      'assets_planned',
      'generating',
      'revision_required',
      'approved',
      'packaged',
    ].includes(p.state)
  )
    throw new DomainError('Build the storyboard first.');
  assertScriptReady(p);
  transaction(() => {
    invalidateOutput(p);
    save('project', {
      ...get<Project>('project', id),
      productionApproach: 'image_to_video',
    });
    for (const s of list<Scene>('scene', id))
      save('scene', {
        ...s,
        revision: s.revision + 1,
        assetId: undefined,
        reviewFrameIds: [],
        status: 'planned',
      });
  });
  event(id, 'production.image_first_enabled');
}
export function reviseVisual(
  id: string,
  sceneId: string | undefined,
  input: unknown,
) {
  const p = get<Project>('project', id);
  if (isBusy(id) || p.productionApproach !== 'image_to_video')
    throw new DomainError('Finish active work before revising images.');
  const { prompt } = z
    .object({
      prompt: z
        .string()
        .trim()
        .min(20)
        .max(sceneId ? 800 : 900),
    })
    .parse(input);
  const scenes = list<Scene>('scene', id);
  if (sceneId && !scenes.some((s) => s.id === sceneId))
    throw new DomainError('Scene belongs to another project', 404);
  if (!p.referencePrompt)
    throw new DomainError('Create the visual plan first.');
  transaction(() => {
    invalidateOutput(p);
    if (!sceneId)
      save('project', {
        ...get<Project>('project', id),
        referencePrompt: prompt,
        referenceAssetId: undefined,
        referenceApproved: false,
        referenceRevision: (p.referenceRevision ?? 1) + 1,
      });
    for (const s of scenes.filter((s) => !sceneId || s.id === sceneId))
      save('scene', {
        ...s,
        imagePrompt: sceneId ? prompt : s.imagePrompt,
        ...(sceneId ? { visualDescription: prompt } : {}),
        storyboardRevision: (s.storyboardRevision ?? 1) + 1,
        storyboardAssetId: undefined,
        storyboardApproved: false,
        revision: s.revision + 1,
        assetId: undefined,
        reviewFrameIds: [],
        status: 'planned',
      });
  });
  event(id, 'visual.revised', { sceneId });
}
export function approveVisual(
  id: string,
  sceneId: string | undefined,
  input: unknown,
) {
  const p = get<Project>('project', id);
  if (isBusy(id) || p.productionApproach !== 'image_to_video')
    throw new DomainError('Finish active work before reviewing images.');
  const { assetId } = z.object({ assetId: z.uuid() }).parse(input);
  if (sceneId) {
    const s = get<Scene>('scene', sceneId);
    if (
      s.projectId !== id ||
      s.storyboardAssetId !== assetId ||
      !p.referenceApproved
    )
      throw new DomainError(
        'Image changed. Refresh and review the current image.',
      );
    save('scene', { ...s, storyboardApproved: true });
  } else {
    if (p.referenceAssetId !== assetId)
      throw new DomainError('Reference changed. Refresh and review it.');
    save('project', { ...p, referenceApproved: true, error: undefined });
  }
  event(id, 'visual.approved', { sceneId, assetId });
}
