import { base, save } from './db';
import { scoreConcept } from './policy';
import {
  sceneOutput,
  type Project,
  type Concept,
  type Scene,
} from '../shared/domain';
export const promptVersions = {
  concept: 'director/1.0.0',
  script: 'screenwriter/1.0.0',
  storyboard: 'cinematographer/1.0.0',
  video: 'cinematic-shot/1.0.0',
};
export function trace(
  projectId: string,
  name: keyof typeof promptVersions,
  input: unknown,
  output: unknown,
  sceneId?: string,
) {
  save('prompt', {
    ...base(),
    projectId,
    sceneId,
    name,
    version: promptVersions[name],
    provider: 'development',
    model: 'deterministic-v1',
    input,
    output,
  });
}
export function constructPrompt(
  scene: Pick<
    Scene,
    | 'visualDescription'
    | 'cameraDirection'
    | 'lighting'
    | 'mood'
    | 'purpose'
    | 'durationSeconds'
  >,
  bible: Project['creativeBible'],
) {
  return [
    `Purpose: ${scene.purpose}.`,
    `${scene.durationSeconds}-second shot. ${scene.visualDescription}`,
    `Motivated camera: ${scene.cameraDirection}. Lighting: ${scene.lighting}. Emotional tone: ${scene.mood}.`,
    `Continuity: ${bible.visualRules.join('; ')}. Palette: ${bible.palette.join(', ')}. Characters: ${bible.characters.join('; ') || 'no recurring characters'}.`,
    'Maintain coherent motion and subject identity. No added lettering, watermarks or logos.',
  ].join('\n');
}
export function conceptsFor(p: Project): Concept[] {
  const options = [
    {
      suffix: 'The last witness',
      hook: 'Everything is gone. Except the one thing still waiting.',
      type: 'unresolved mystery',
      emotion: 'wonder → loneliness → hope',
      criteria: {
        hook: 91,
        emotion: 90,
        novelty: 80,
        clarity: 88,
        feasibility: 96,
        retention: 86,
      },
    },
    {
      suffix: 'A world in reverse',
      hook: 'Start at the ending. Then discover how we arrived here.',
      type: 'narrative cold open',
      emotion: 'surprise → curiosity → understanding',
      criteria: {
        hook: 85,
        emotion: 78,
        novelty: 88,
        clarity: 81,
        feasibility: 92,
        retention: 84,
      },
    },
    {
      suffix: 'One small signal',
      hook: 'In all this silence, something answers.',
      type: 'emotional tension',
      emotion: 'quiet → tension → connection',
      criteria: {
        hook: 89,
        emotion: 94,
        novelty: 77,
        clarity: 90,
        feasibility: 95,
        retention: 89,
      },
    },
  ];
  const out = options.map((o) => ({
    ...base(),
    projectId: p.id,
    title: `${p.title}: ${o.suffix}`,
    premise: `${p.brief} Told through ${o.suffix.toLowerCase()}, with a restrained reveal and an earned final image.`,
    hook: o.hook,
    hookType: o.type,
    arc: [
      'Establish an unanswered question',
      'Find a trace that changes its meaning',
      'Return to the opening with a new understanding',
    ],
    ending: 'A final image transforms the meaning of the opening.',
    emotionalTarget: o.emotion,
    visualIdentity:
      'Restrained cinematic contrast, atmospheric depth, deliberate camera movement',
    score: scoreConcept(o.criteria),
    criteria: o.criteria,
    explanation:
      'Deterministic development rubric; these scores are not predictions of audience performance.',
    selected: false,
  }));
  trace(p.id, 'concept', { brief: p.brief }, out);
  return out;
}
export function scenesFor(p: Project, c: Concept): Scene[] {
  const count = 3;
  const duration = p.duration / count;
  const out = Array.from({ length: count }, (_, i) => {
    const spec = sceneOutput.parse({
      sceneNumber: i + 1,
      durationSeconds: duration,
      purpose: c.arc[i],
      narration: [
        c.hook,
        'A trace remains. It changes the way we see this place.',
        'Perhaps an ending is only a different way to begin.',
      ][i],
      visualDescription: [
        `Establish the world described by: ${p.brief}. Reveal scale through a solitary focal subject.`,
        `Move closer to a meaningful detail within ${p.title}. Show the trace that makes the initial mystery personal.`,
        `Return to the opening composition in ${p.title}; reveal a subtle change that resolves the emotional question.`,
      ][i],
      cameraDirection: [
        'Slow establishing dolly forward',
        'Measured close-up with shallow depth of field',
        'Pull back to a wide, held final frame',
      ][i],
      lighting:
        'Motivated practical light, atmospheric separation, controlled highlights',
      mood: c.emotionalTarget,
      transition: i === 2 ? 'hold' : 'cut on emotional beat',
      soundDesign: [
        'Low environmental ambience',
        'A single restrained tonal accent',
        'Ambience resolves into silence',
      ][i],
    });
    const scene: Scene = {
      ...base(),
      ...spec,
      projectId: p.id,
      startTime: i * duration,
      endTime: (i + 1) * duration,
      prompt: '',
      negativePrompt: 'watermark, extra limbs, broken geometry, unwanted text',
      provider: p.videoProvider ?? 'development',
      status: 'planned',
      revision: 1,
    };
    scene.prompt = constructPrompt(scene, p.creativeBible);
    return scene;
  });
  trace(p.id, 'script', { concept: c.id, duration: p.duration }, out);
  return out;
}

// Keep complete instructions. Never silently cut a camera or continuity sentence.
export function completeVideoPrompt(
  scene: Scene,
  bible: Project['creativeBible'],
) {
  const essential = `${scene.visualDescription.trim()} Camera: ${scene.cameraDirection.trim()}`;
  if (essential.length > 1000) return essential; // Provider gate reports an actionable length error.
  let prompt = essential;
  for (const sentence of [
    `Continuity: ${[...bible.characters, ...bible.visualRules].join('; ')}.`,
    `Lighting: ${scene.lighting}.`,
    `Palette: ${bible.palette.join(', ')}.`,
    `Mood: ${scene.mood}.`,
  ])
    if (prompt.length + sentence.length + 1 <= 1000) prompt += ` ${sentence}`;
  return prompt;
}
