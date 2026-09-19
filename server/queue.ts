import { list } from './db';
import type { Generation } from '../shared/domain';
import { db, base, now, jobFromRow, event, transaction, jobs } from './db';
import type { Job, JobType } from '../shared/domain';
import { DomainError, retryDelay } from './policy';
export class JobDeferred extends Error {
  constructor(public delayMs = 10000) {
    super('Waiting for media provider');
  }
}
export function enqueue(
  projectId: string,
  type: JobType,
  key: string,
  sceneId?: string,
  payload: Record<string, unknown> = {},
) {
  const id = base().id;
  db.prepare(
    'INSERT OR IGNORE INTO jobs(id,project_id,scene_id,type,status,run_at,idempotency_key,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(
    id,
    projectId,
    sceneId ?? null,
    type,
    'queued',
    Date.now(),
    key,
    JSON.stringify(payload),
    now(),
    now(),
  );
  return jobFromRow(
    db.prepare('SELECT * FROM jobs WHERE idempotency_key=?').get(key)!,
  );
}
export function claim(timeout: number): Job | undefined {
  return transaction(() => {
    const expired = db
      .prepare("SELECT * FROM jobs WHERE status='running' AND lease_until<?")
      .all(Date.now());
    for (const r of expired) {
      const exhausted = Number(r.attempt) >= Number(r.max_attempts);
      db.prepare(
        'UPDATE jobs SET status=?,error=?,run_at=?,updated_at=? WHERE id=?',
      ).run(
        exhausted ? 'failed' : 'queued',
        'Worker lease expired; resumed safely',
        Date.now(),
        now(),
        String(r.id),
      );
      event(String(r.project_id), 'job.lease_expired', { jobId: r.id });
    }
    const r = db
      .prepare(
        "SELECT j.* FROM jobs j WHERE j.status='queued' AND j.run_at<=? AND NOT EXISTS(SELECT 1 FROM jobs running WHERE running.project_id=j.project_id AND running.status='running') ORDER BY j.priority DESC,j.created_at LIMIT 1",
      )
      .get(Date.now());
    if (!r) return;
    db.prepare(
      "UPDATE jobs SET status='running',attempt=attempt+1,lease_until=?,updated_at=? WHERE id=?",
    ).run(Date.now() + timeout + 30000, now(), String(r.id));
    return jobFromRow(
      db.prepare('SELECT * FROM jobs WHERE id=?').get(String(r.id))!,
    );
  });
}
export function finish(job: Job, error?: unknown) {
  const current = db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id);
  if (current?.status === 'cancelled') return;
  if (error instanceof JobDeferred) {
    db.prepare(
      "UPDATE jobs SET status='queued',attempt=MAX(0,attempt-1),error=NULL,run_at=?,lease_until=0,updated_at=? WHERE id=?",
    ).run(Date.now() + error.delayMs, now(), job.id);
    return;
  }
  const message =
    error instanceof Error ? error.message : error ? String(error) : undefined;
  const retry =
    Boolean(error) &&
    !(error instanceof DomainError) &&
    job.attempt < job.maxAttempts;
  const status = error ? (retry ? 'queued' : 'failed') : 'succeeded';
  db.prepare(
    'UPDATE jobs SET status=?,progress=?,error=?,run_at=?,lease_until=0,updated_at=? WHERE id=?',
  ).run(
    status,
    error ? 0 : 100,
    message ?? null,
    Date.now() + retryDelay(job.attempt),
    now(),
    job.id,
  );
  event(job.projectId, `job.${status}`, {
    jobId: job.id,
    type: job.type,
    attempt: job.attempt,
    error: message ?? null,
  });
}
export function cancelJob(id: string) {
  if (
    list<Generation>('generation').some(
      (g) =>
        g.jobId === id &&
        g.provider === 'runway' &&
        !['failed', 'completed'].includes(g.status),
    )
  )
    throw new DomainError(
      'Runway submission has started. The task will keep being checked to retain its result and billing; pause the workflow to stop later stages.',
    );
  const r = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if (!r) throw new DomainError('Job not found', 404);
  if (!['queued', 'running'].includes(String(r.status)))
    throw new DomainError('Only active jobs can be cancelled');
  db.prepare("UPDATE jobs SET status='cancelled',updated_at=? WHERE id=?").run(
    now(),
    id,
  );
  event(String(r.project_id), 'job.cancelled', { jobId: id });
}
export function retryJob(id: string) {
  const r = db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  if (!r || !['failed', 'cancelled'].includes(String(r.status)))
    throw new DomainError('Only failed or cancelled jobs can be retried');
  if (Number(r.attempt) >= Number(r.max_attempts))
    throw new DomainError('Retry limit reached');
  db.prepare(
    "UPDATE jobs SET status='queued',error=NULL,run_at=?,updated_at=? WHERE id=?",
  ).run(Date.now(), now(), id);
}
export const isBusy = (projectId: string) =>
  jobs(projectId).some((j) => ['queued', 'running'].includes(j.status));
