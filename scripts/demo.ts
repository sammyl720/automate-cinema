export {};
if (process.env.STUDIO_DATA_DIR === undefined)
  process.env.STUDIO_DATA_DIR = './data';
const { createProject, startAutomation, detail } =
  await import('../server/service');
const { startWorker } = await import('../server/worker');
const { mediaPath } = await import('../server/media');
const p = createProject({
  title: 'Demo — The Last Signal',
  brief:
    'A lighthouse keeper discovers a faint answer on a silent ocean. Build a restrained three-shot story of isolation, discovery and hope.',
  duration: 6,
  mode: 'autonomous',
});
const stop = startWorker();
startAutomation(p.id);
let last = '';
try {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const d = detail(p.id);
    if (last !== d.project.state) {
      last = d.project.state;
      console.log(
        `${last} · ${d.jobs.filter((j) => j.status === 'succeeded').length} jobs completed`,
      );
    }
    if (d.project.error) throw new Error(d.project.error);
    if (d.project.state === 'packaged') {
      const render = d.assets.find((a) => a.type === 'render')!;
      console.log(
        `\nDevelopment preview: ${mediaPath(render.path)}\n${d.packages.length} platform packages; cost $${d.project.spentUsd.toFixed(2)}.\nTest patterns and tone only; not published.`,
      );
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (detail(p.id).project.state !== 'packaged')
    throw new Error('Demo timed out');
} finally {
  await stop();
}
