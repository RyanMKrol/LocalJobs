import { db } from '../index.js';
import type { JobDefinition } from '../../core/types.js';

/**
 * Upsert a job definition. A job is only ever a workflow member (T037/T070), so
 * it carries no schedule or enable toggle — those live on the workflow. Only the
 * job's identity + execution params (timeout/retries) are synced here.
 */
const upsertJobStmt = db.prepare(`
  INSERT INTO jobs (name, description, timeout_ms, max_retries)
  VALUES (@name, @description, @timeout_ms, @max_retries)
  ON CONFLICT(name) DO UPDATE SET
    description = excluded.description,
    timeout_ms  = CASE WHEN timeout_ms_overridden = 1 THEN timeout_ms ELSE excluded.timeout_ms END,
    max_retries = excluded.max_retries
`);

export function syncJob(def: JobDefinition): void {
  upsertJobStmt.run({
    name: def.name,
    description: def.description ?? '',
    timeout_ms: def.timeoutMs ?? 0,
    max_retries: def.maxRetries ?? 0,
  });
}

export interface JobRow {
  name: string;
  description: string;
  timeout_ms: number;
  timeout_ms_overridden: number;
  timeout_ms_overridden_at: string | null;
  max_retries: number;
  created_at: string;
}

export function getJob(name: string): JobRow | undefined {
  return db.prepare('SELECT * FROM jobs WHERE name = ?').get(name) as JobRow | undefined;
}

export function listJobs(): JobRow[] {
  return db.prepare('SELECT * FROM jobs ORDER BY name').all() as JobRow[];
}

/**
 * Persist a USER override of a job's `timeoutMs` (T297) — mirrors
 * `updateWorkflowSchedule`/`updateWorkflowConcurrency`: a dashboard edit takes
 * ownership so a later `syncJob` (code re-sync / daemon restart) preserves it
 * instead of reverting to the manifest value.
 */
export function updateJobTimeout(name: string, timeoutMs: number): JobRow | undefined {
  const info = db
    .prepare("UPDATE jobs SET timeout_ms = ?, timeout_ms_overridden = 1, timeout_ms_overridden_at = datetime('now') WHERE name = ?")
    .run(timeoutMs, name);
  if (info.changes === 0) return undefined;
  return getJob(name);
}
