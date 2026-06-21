import { randomUUID } from 'node:crypto';
import { db } from './index.js';
import type { JobDefinition, LogLevel, RunRow, RunStatus, RunTrigger } from '../core/types.js';

/**
 * Upsert a job definition. The user-owned `enabled` flag is preserved on
 * existing rows so re-syncing code never re-enables something you turned off.
 */
const upsertJobStmt = db.prepare(`
  INSERT INTO jobs (name, description, schedule, timeout_ms, max_retries, enabled)
  VALUES (@name, @description, @schedule, @timeout_ms, @max_retries, 1)
  ON CONFLICT(name) DO UPDATE SET
    description = excluded.description,
    schedule    = excluded.schedule,
    timeout_ms  = excluded.timeout_ms,
    max_retries = excluded.max_retries
`);

export function syncJob(def: JobDefinition): void {
  upsertJobStmt.run({
    name: def.name,
    description: def.description ?? '',
    schedule: def.schedule ?? null,
    timeout_ms: def.timeoutMs ?? 0,
    max_retries: def.maxRetries ?? 0,
  });
}

export interface JobRow {
  name: string;
  description: string;
  schedule: string | null;
  timeout_ms: number;
  max_retries: number;
  enabled: number;
  created_at: string;
}

export function getJob(name: string): JobRow | undefined {
  return db.prepare('SELECT * FROM jobs WHERE name = ?').get(name) as JobRow | undefined;
}

export function listJobs(): JobRow[] {
  return db.prepare('SELECT * FROM jobs ORDER BY name').all() as JobRow[];
}

export function setJobEnabled(name: string, enabled: boolean): void {
  db.prepare('UPDATE jobs SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name);
}

// ---- runs ----

export function createRun(jobName: string, trigger: RunTrigger, attempt = 1): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO runs (id, job_name, status, trigger, attempt, started_at)
    VALUES (?, ?, 'running', ?, ?, datetime('now'))
  `).run(id, jobName, trigger, attempt);
  return id;
}

export function setProgress(runId: string, pct: number, message: string): void {
  db.prepare('UPDATE runs SET progress = ?, progress_msg = ? WHERE id = ?')
    .run(Math.max(0, Math.min(100, Math.round(pct))), message, runId);
}

export function finishRun(
  runId: string,
  status: RunStatus,
  opts: { exitCode?: number | null; error?: string | null } = {},
): void {
  db.prepare(`
    UPDATE runs SET
      status = ?,
      finished_at = datetime('now'),
      duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER),
      exit_code = ?,
      error = ?,
      progress = CASE WHEN ? = 'success' THEN 100 ELSE progress END
    WHERE id = ?
  `).run(status, opts.exitCode ?? null, opts.error ?? null, status, runId);
}

export function addLog(runId: string, message: string, level: LogLevel = 'info'): void {
  db.prepare('INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)')
    .run(runId, level, message);
}

export function getRun(runId: string): RunRow | undefined {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
}

export function listRunsForJob(jobName: string, limit = 50): RunRow[] {
  return db.prepare('SELECT * FROM runs WHERE job_name = ? ORDER BY started_at DESC LIMIT ?')
    .all(jobName, limit) as RunRow[];
}

export function listRecentRuns(limit = 50): RunRow[] {
  return db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit) as RunRow[];
}

export function getLogs(runId: string, afterId = 0): { id: number; ts: string; level: LogLevel; message: string }[] {
  return db.prepare('SELECT id, ts, level, message FROM run_logs WHERE run_id = ? AND id > ? ORDER BY id')
    .all(runId, afterId) as { id: number; ts: string; level: LogLevel; message: string }[];
}

export function hasActiveRun(jobName: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE job_name = ? AND status = 'running'`)
    .get(jobName) as { n: number };
  return row.n > 0;
}

export function lastRunForJob(jobName: string): RunRow | undefined {
  return db.prepare('SELECT * FROM runs WHERE job_name = ? ORDER BY started_at DESC LIMIT 1')
    .get(jobName) as RunRow | undefined;
}

/** On daemon startup, any run still marked 'running' is orphaned from a crash. */
export function reapOrphanRuns(): number {
  const res = db.prepare(`
    UPDATE runs SET status = 'cancelled', finished_at = datetime('now'),
      error = 'Orphaned by daemon restart'
    WHERE status = 'running'
  `).run();
  return res.changes;
}

// ---- work items (per-item idempotency ledger) ----

export type WorkStatus = 'success' | 'failed' | 'skipped';

export interface WorkItemRow {
  job_name: string;
  item_key: string;
  status: WorkStatus;
  attempts: number;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

/** Fetch the ledger row for one work item, if it exists. */
export function getWorkItem(jobName: string, itemKey: string): WorkItemRow | undefined {
  return db.prepare('SELECT * FROM work_items WHERE job_name = ? AND item_key = ?')
    .get(jobName, itemKey) as WorkItemRow | undefined;
}

/**
 * Has this item been fully processed and so should NOT be reprocessed?
 * True when it succeeded, or it failed but has exhausted its retry budget.
 */
export function isWorkItemDone(jobName: string, itemKey: string, maxAttempts: number): boolean {
  const row = getWorkItem(jobName, itemKey);
  if (!row) return false;
  if (row.status === 'success') return true;
  return row.status === 'failed' && row.attempts >= maxAttempts;
}

/** Record (upsert) the outcome of processing a work item. `detail` is JSON-serialized. */
export function markWorkItem(
  jobName: string,
  itemKey: string,
  status: WorkStatus,
  opts: { attempts?: number; detail?: unknown } = {},
): void {
  const detail = opts.detail === undefined ? null : JSON.stringify(opts.detail);
  db.prepare(`
    INSERT INTO work_items (job_name, item_key, status, attempts, detail)
    VALUES (@job, @key, @status, @attempts, @detail)
    ON CONFLICT(job_name, item_key) DO UPDATE SET
      status = excluded.status,
      attempts = excluded.attempts,
      detail = excluded.detail,
      updated_at = datetime('now')
  `).run({ job: jobName, key: itemKey, status, attempts: opts.attempts ?? 1, detail });
}

/** Count of work items per status for a job, e.g. { success: 1700, failed: 3 }. */
export function workItemCounts(jobName: string): Record<string, number> {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM work_items WHERE job_name = ? GROUP BY status')
    .all(jobName) as { status: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export interface StuckItem {
  job_name: string;
  item_key: string;
  attempts: number;
  detail: unknown;
  updated_at: string;
}

/**
 * Items that have permanently given up: failed and out of retries. These won't
 * be reprocessed, so they need surfacing (dashboard / alerts) rather than being
 * silently swallowed. `minAttempts` is the give-up threshold (jobs default to 4).
 */
export function stuckItems(minAttempts = 4): StuckItem[] {
  const rows = db.prepare(
    "SELECT job_name, item_key, attempts, detail, updated_at FROM work_items WHERE status = 'failed' AND attempts >= ? ORDER BY job_name, updated_at DESC",
  ).all(minAttempts) as { job_name: string; item_key: string; attempts: number; detail: string | null; updated_at: string }[];
  return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

/** How many items have given up for one job (failed, out of retries). */
export function stuckCount(jobName: string, minAttempts = 4): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM work_items WHERE job_name = ? AND status = 'failed' AND attempts >= ?",
  ).get(jobName, minAttempts) as { n: number }).n;
}

// ---- usage meter (per-day / per-month spend caps) ----

/** Record one metered action (e.g. one external API call) against a job. */
export function recordUsage(jobName: string): void {
  db.prepare('INSERT INTO job_usage (job_name) VALUES (?)').run(jobName);
}

/** Actions recorded for a job since the start of the current UTC day. */
export function usageToday(jobName: string): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM job_usage WHERE job_name = ? AND ts >= datetime('now','start of day')",
  ).get(jobName) as { n: number }).n;
}

/** Actions recorded for a job since the start of the current UTC month. */
export function usageThisMonth(jobName: string): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM job_usage WHERE job_name = ? AND ts >= datetime('now','start of month')",
  ).get(jobName) as { n: number }).n;
}

/**
 * Check a job against its per-day and per-month caps. Returns how much headroom
 * is left and, if a cap is hit, a human-readable reason to log and stop on.
 */
export function capStatus(
  jobName: string,
  dailyCap: number,
  monthlyCap: number,
): { allowed: boolean; reason: string; today: number; month: number; dayLeft: number; monthLeft: number } {
  const today = usageToday(jobName);
  const month = usageThisMonth(jobName);
  const dayLeft = Math.max(0, dailyCap - today);
  const monthLeft = Math.max(0, monthlyCap - month);
  let reason = '';
  if (month >= monthlyCap) reason = `monthly cap reached (${month}/${monthlyCap})`;
  else if (today >= dailyCap) reason = `daily cap reached (${today}/${dailyCap})`;
  return { allowed: reason === '', reason, today, month, dayLeft, monthLeft };
}

/** Seed N usage rows for the current month (one-time backfill from a legacy counter). */
export function backfillMonthlyUsage(jobName: string, count: number): void {
  const insert = db.prepare('INSERT INTO job_usage (job_name) VALUES (?)');
  const tx = db.transaction((n: number) => { for (let i = 0; i < n; i++) insert.run(jobName); });
  tx(count);
}
