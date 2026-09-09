import { pathToFileURL } from 'node:url';
import { config } from './config';
import { claim, finish } from './queue';
import { handle } from './handlers';
import { db, list, get, save, event } from './db';
import { advance } from './service';
import type { Project } from '../shared/domain';
export function startWorker() {
  let stopping = false;
  const active = new Map<string, AbortController>();
  let polling = false;
  const timer = setInterval(() => {
    if (polling || stopping) return;
    polling = true;
    try {
      for (const [id, controller] of active) {
        const row = db.prepare('SELECT status FROM jobs WHERE id=?').get(id);
        if (row?.status === 'cancelled')
          controller.abort(new Error('Cancelled by user'));
      }
      for (const p of list<Project>('project')) advance(p.id);
      while (active.size < config.WORKER_CONCURRENCY) {
        const job = claim(config.JOB_TIMEOUT_MS);
        if (!job) break;
        const controller = new AbortController();
        active.set(job.id, controller);
        const timeout = setTimeout(
          () => controller.abort(new Error('Job timed out')),
          config.JOB_TIMEOUT_MS,
        );
        void handle(job, controller.signal)
          .then(
            () => finish(job),
            (error) => {
              finish(job, error);
              const row = db
                .prepare('SELECT status FROM jobs WHERE id=?')
                .get(job.id);
              if (row?.status === 'failed') {
                const p = get<Project>('project', job.projectId);
                save('project', {
                  ...p,
                  automationRunning: false,
                  error: error instanceof Error ? error.message : 'Job failed',
                });
                event(p.id, 'workflow.blocked', { jobId: job.id });
              }
            },
          )
          .finally(() => {
            clearTimeout(timeout);
            active.delete(job.id);
          });
      }
    } catch (e) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'worker.poll_failed',
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      polling = false;
    }
  }, 300);
  return async () => {
    stopping = true;
    clearInterval(timer);
    for (const c of active.values()) c.abort(new Error('Worker shutting down'));
    while (active.size) await new Promise((r) => setTimeout(r, 50));
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const stop = startWorker();
  console.log(
    JSON.stringify({
      event: 'worker.started',
      concurrency: config.WORKER_CONCURRENCY,
    }),
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => void stop().then(() => process.exit(0)));
}
