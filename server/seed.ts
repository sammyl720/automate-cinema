import { pathToFileURL } from 'node:url';
import { list, save } from './db';
import { createProject, selectConcept } from './service';
import { conceptsFor, scenesFor } from './creative';
import type { Project, Script } from '../shared/domain';
import { base } from './db';
export function seed() {
  if (list<Project>('project').length) return;
  const examples = [
    {
      title: 'The Last Lighthouse on Earth',
      brief:
        'A cinematic atmospheric story about the final functioning lighthouse in a flooded future. Its keeper discovers that someone is still answering the light.',
      kind: 'fiction' as const,
    },
    {
      title: 'What Falling Into Saturn Might Look Like',
      brief:
        'A science-inspired cinematic descent through Saturn’s atmosphere. Research pressure, clouds and the absence of a solid surface before developing factual narration.',
      kind: 'factual' as const,
    },
    {
      title: 'The Forest That Remembers Everyone Who Entered',
      brief:
        'A surreal mysterious short film: a traveler finds that the trees preserve small echoes of everyone who has passed beneath them.',
      kind: 'fiction' as const,
    },
  ];
  for (const [i, e] of examples.entries()) {
    let p = createProject({ ...e, duration: 15 });
    if (i === 0) {
      const concepts = conceptsFor(p);
      for (const c of concepts) save('concept', c);
      p = selectConcept(p.id, concepts[0].id);
      const scenes = scenesFor(p, concepts[0]);
      for (const s of scenes) save('scene', s);
      save('script', {
        ...base(),
        projectId: p.id,
        title: p.title,
        hook: concepts[0].hook,
        ending: concepts[0].ending,
        version: 1,
        estimatedDurationSeconds: p.duration,
        narration: scenes.map((s) => ({
          sceneNumber: s.sceneNumber,
          text: s.narration,
          start: s.startTime,
          end: s.endTime,
        })),
      } satisfies Script);
      save('project', { ...p, state: 'assets_planned' });
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  seed();
  console.log('Development projects seeded (existing data preserved).');
}
