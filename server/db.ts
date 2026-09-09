import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config';
import type { RecordBase, Job } from '../shared/domain';
mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(join(config.dataDir, 'studio.sqlite'));
db.exec('PRAGMA busy_timeout=5000');
db.exec(
  readFileSync(
    new URL('./migrations/001_initial.sql', import.meta.url),
    'utf8',
  ),
);
export const now = () => new Date().toISOString();
export const base = (): RecordBase => ({
  id: randomUUID(),
  createdAt: now(),
  updatedAt: now(),
});
export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
export function save<T extends RecordBase>(kind: string, value: T): T {
  const v = { ...value, updatedAt: now() };
  db.prepare(
    'INSERT INTO records(id,kind,project_id,data,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at',
  ).run(
    v.id,
    kind,
    'projectId' in v ? String(v.projectId) : null,
    JSON.stringify(v),
    v.createdAt,
    v.updatedAt,
    v.deletedAt ?? null,
  );
  return v;
}
export function get<T>(kind: string, id: string): T {
  const r = db
    .prepare(
      'SELECT data FROM records WHERE kind=? AND id=? AND deleted_at IS NULL',
    )
    .get(kind, id);
  if (!r) throw new Error(`${kind} not found`);
  return JSON.parse(r.data as string) as T;
}
export function list<T>(kind: string, projectId?: string): T[] {
  const rows = projectId
    ? db
        .prepare(
          'SELECT data FROM records WHERE kind=? AND project_id=? AND deleted_at IS NULL ORDER BY created_at',
        )
        .all(kind, projectId)
    : db
        .prepare(
          'SELECT data FROM records WHERE kind=? AND deleted_at IS NULL ORDER BY created_at',
        )
        .all(kind);
  return rows.map((r) => JSON.parse(r.data as string) as T);
}
export function event(
  projectId: string,
  type: string,
  detail: Record<string, unknown> = {},
) {
  return save('event', { ...base(), projectId, type, detail });
}
export function jobs(projectId?: string): Job[] {
  return (
    projectId
      ? db
          .prepare(
            'SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC',
          )
          .all(projectId)
      : db
          .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200')
          .all()
  ).map(jobFromRow);
}
export function jobFromRow(r: Record<string, unknown>): Job {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    sceneId: r.scene_id ? String(r.scene_id) : undefined,
    type: r.type as Job['type'],
    status: r.status as Job['status'],
    attempt: Number(r.attempt),
    maxAttempts: Number(r.max_attempts),
    runAt: Number(r.run_at),
    leaseUntil: Number(r.lease_until),
    progress: Number(r.progress),
    priority: Number(r.priority),
    key: String(r.idempotency_key),
    payload: JSON.parse(String(r.payload)),
    error: r.error ? String(r.error) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
