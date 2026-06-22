import { randomUUID } from 'node:crypto';
import { db } from './index.js';
import type {
  JobDefinition,
  LogLevel,
  WorkflowDefinition,
  WorkflowRunRow,
  WorkflowRunStatus,
  RunRow,
  RunStatus,
  RunTrigger,
  ServiceDefinition,
} from '../core/types.js';

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

export function createRun(
  jobName: string,
  trigger: RunTrigger,
  attempt = 1,
  workflowRunId: string | null = null,
): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO runs (id, job_name, status, trigger, attempt, started_at, workflow_run_id)
    VALUES (?, ?, 'running', ?, ?, datetime('now'), ?)
  `).run(id, jobName, trigger, attempt, workflowRunId);
  return id;
}

/** Record a terminal run row without spawning a process — used for workflow
 *  members that are SKIPPED because an upstream dependency didn't succeed. */
export function recordSkippedRun(jobName: string, workflowRunId: string, reason: string): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO runs (id, job_name, status, trigger, attempt, started_at, finished_at, duration_ms, error, workflow_run_id)
    VALUES (?, ?, 'skipped', 'workflow', 1, datetime('now'), datetime('now'), 0, ?, ?)
  `).run(id, jobName, reason, workflowRunId);
  return id;
}

/** Record a terminal FAILED run row without spawning a process — used when a
 *  validation gate between workflow stages is violated, so the consumer never
 *  runs but the failure is surfaced as a first-class failed run (with the drift
 *  detail in `error`). */
export function recordGateFailure(jobName: string, workflowRunId: string, error: string): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO runs (id, job_name, status, trigger, attempt, started_at, finished_at, duration_ms, error, workflow_run_id)
    VALUES (?, ?, 'failed', 'workflow', 1, datetime('now'), datetime('now'), 0, ?, ?)
  `).run(id, jobName, error, workflowRunId);
  return id;
}

export function setProgress(runId: string, pct: number, message: string): void {
  db.prepare('UPDATE runs SET progress = ?, progress_msg = ? WHERE id = ?')
    .run(Math.max(0, Math.min(100, Math.round(pct))), message, runId);
  // If this run is a workflow member, roll its progress up into the parent
  // workflow run in real time, so the workflow reflects in-flight member
  // progress rather than only whole settled stages.
  const row = db.prepare('SELECT workflow_run_id FROM runs WHERE id = ?')
    .get(runId) as { workflow_run_id: string | null } | undefined;
  if (row?.workflow_run_id) rollUpWorkflowProgress(row.workflow_run_id);
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

export type WorkStatus = 'success' | 'failed' | 'skipped' | 'ignored';

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
 * True when it succeeded, was manually ignored, or it failed but has exhausted
 * its retry budget. An `ignored` row is a human's "give up on this one
 * permanently" — it must never be reprocessed (see {@link ignoreWorkItem}).
 */
export function isWorkItemDone(jobName: string, itemKey: string, maxAttempts: number): boolean {
  const row = getWorkItem(jobName, itemKey);
  if (!row) return false;
  if (row.status === 'success' || row.status === 'ignored') return true;
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

/** "Unstick" an item: delete its failed ledger row so it's retried fresh on the
 *  next run. Returns the number of rows removed (0 if it wasn't failed). */
export function unstickWorkItem(jobName: string, itemKey: string): number {
  return db.prepare("DELETE FROM work_items WHERE job_name = ? AND item_key = ? AND status = 'failed'")
    .run(jobName, itemKey).changes;
}

/**
 * "Ignore" a stuck item: permanently mark a failed ledger row as `ignored`
 * so it drops off the stuck list and is never reprocessed (genuinely bad data
 * that will never succeed). The OPPOSITE of {@link unstickWorkItem}: unstick
 * deletes the row to RETRY it; ignore keeps the row but parks it as done so it
 * neither retries nor shows as stuck (it surfaces ONLY on the overview's Ignored
 * tile). MANUAL ONLY — nothing in the run/schedule path calls this; it's invoked
 * solely from the dashboard control. Only acts on a currently-`failed` row (a
 * stuck item), so it can't park a successful one. There is ONE manual-park
 * concept ("ignored"); it is never resurrected by a re-run because
 * {@link isWorkItemDone} treats `ignored` as done.
 * Returns the number of rows updated (0 if the item wasn't failed). */
export function ignoreWorkItem(jobName: string, itemKey: string): number {
  return db.prepare(
    "UPDATE work_items SET status = 'ignored', updated_at = datetime('now') WHERE job_name = ? AND item_key = ? AND status = 'failed'",
  ).run(jobName, itemKey).changes;
}

/**
 * Manually-ignored items (parked via {@link ignoreWorkItem}). Surfaced ONLY on
 * the overview's Ignored tile — they are deliberately NOT stuck and never count
 * toward stuck. Shares the {@link StuckItem} shape for the dashboard.
 */
export function ignoredItems(): StuckItem[] {
  const rows = db.prepare(
    "SELECT job_name, item_key, attempts, detail, updated_at FROM work_items WHERE status = 'ignored' ORDER BY job_name, updated_at DESC",
  ).all() as { job_name: string; item_key: string; attempts: number; detail: string | null; updated_at: string }[];
  return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

/** A ledger row identified for / removed by a manual prune. */
export interface PrunedWorkItem {
  item_key: string;
  status: WorkStatus;
  attempts: number;
}

/**
 * Ledger rows for a job whose `item_key` is NOT in the given current-input set
 * — i.e. orphans left behind when the input changed (e.g. a source id was
 * corrected). Read-only preview for the manual prune; modifies nothing.
 */
export function orphanedWorkItems(jobName: string, currentKeys: Iterable<string>): PrunedWorkItem[] {
  const keep = new Set(currentKeys);
  const rows = db.prepare('SELECT item_key, status, attempts FROM work_items WHERE job_name = ? ORDER BY item_key')
    .all(jobName) as PrunedWorkItem[];
  return rows.filter((r) => !keep.has(r.item_key));
}

/**
 * Delete the job's ledger rows whose `item_key` is absent from the current
 * input set, keeping the current ones untouched. Returns the removed rows so
 * the caller can surface exactly what was pruned. MANUAL ONLY — never invoked
 * from the run/schedule path. An empty `currentKeys` would orphan everything;
 * the caller is responsible for that being intentional (the API guards it).
 */
export function pruneOrphanedWorkItems(jobName: string, currentKeys: Iterable<string>): PrunedWorkItem[] {
  const orphans = orphanedWorkItems(jobName, currentKeys);
  if (orphans.length === 0) return [];
  const del = db.prepare('DELETE FROM work_items WHERE job_name = ? AND item_key = ?');
  const tx = db.transaction((rows: PrunedWorkItem[]) => { for (const r of rows) del.run(jobName, r.item_key); });
  tx(orphans);
  return orphans;
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

// ════════════════════════════════ workflows ════════════════════════════════

const upsertWorkflowStmt = db.prepare(`
  INSERT INTO workflows (name, description, schedule, enabled)
  VALUES (@name, @description, @schedule, 1)
  ON CONFLICT(name) DO UPDATE SET
    description = excluded.description,
    schedule    = excluded.schedule
`);

/** Upsert a workflow + REPLACE its membership/edges. `enabled` is preserved. */
export function syncWorkflow(def: WorkflowDefinition): void {
  const tx = db.transaction(() => {
    upsertWorkflowStmt.run({
      name: def.name,
      description: def.description ?? '',
      schedule: def.schedule ?? null,
    });
    db.prepare('DELETE FROM workflow_jobs WHERE workflow_name = ?').run(def.name);
    const ins = db.prepare('INSERT INTO workflow_jobs (workflow_name, job_name, depends_on) VALUES (?, ?, ?)');
    for (const ref of def.jobs) ins.run(def.name, ref.job, JSON.stringify(ref.dependsOn ?? []));
  });
  tx();
}

export interface WorkflowRow {
  name: string;
  description: string;
  schedule: string | null;
  enabled: number;
  created_at: string;
}

export function getWorkflow(name: string): WorkflowRow | undefined {
  return db.prepare('SELECT * FROM workflows WHERE name = ?').get(name) as WorkflowRow | undefined;
}

export function listWorkflows(): WorkflowRow[] {
  return db.prepare('SELECT * FROM workflows ORDER BY name').all() as WorkflowRow[];
}

export function setWorkflowEnabled(name: string, enabled: boolean): void {
  db.prepare('UPDATE workflows SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name);
}

export function getWorkflowJobs(name: string): { job_name: string; depends_on: string[] }[] {
  const rows = db.prepare('SELECT job_name, depends_on FROM workflow_jobs WHERE workflow_name = ?')
    .all(name) as { job_name: string; depends_on: string }[];
  return rows.map((r) => ({ job_name: r.job_name, depends_on: JSON.parse(r.depends_on) as string[] }));
}

export function createWorkflowRun(workflowName: string, trigger: RunTrigger): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO workflow_runs (id, workflow_name, status, trigger, started_at)
    VALUES (?, ?, 'running', ?, datetime('now'))
  `).run(id, workflowName, trigger);
  return id;
}

export function setWorkflowProgress(id: string, pct: number, message: string): void {
  db.prepare('UPDATE workflow_runs SET progress = ?, progress_msg = ? WHERE id = ?')
    .run(Math.max(0, Math.min(100, Math.round(pct))), message, id);
}

/** Member-run statuses that are terminal — a stage in any of these counts as a
 *  fully-completed stage for the workflow progress roll-up (regardless of
 *  success/failure), since no further progress will come from it. */
const TERMINAL_RUN_STATUSES = new Set<RunStatus>(['success', 'failed', 'timeout', 'cancelled', 'skipped']);

/**
 * Roll up a workflow run's overall progress (0..100) from its member-job runs.
 * The denominator is the workflow's total stage count (its member jobs); each
 * stage contributes a completion fraction in [0,1] — a terminal run counts as a
 * full stage, a still-running run contributes its own `progress`/100, and a
 * stage with no run yet contributes 0. This is the first-class roll-up: it makes
 * a workflow report meaningful overall progress (e.g. mid-stage) instead of a
 * flat 0% or coarse whole-stage steps. Called in real time whenever a member
 * emits progress (via `setProgress`) or a stage settles.
 *
 * Pass `message` to also update `progress_msg`; omit it to refresh only the
 * percentage (keeps the last stage message intact). Returns the percentage
 * written.
 */
export function rollUpWorkflowProgress(workflowRunId: string, message?: string): number {
  const pr = db.prepare('SELECT workflow_name FROM workflow_runs WHERE id = ?')
    .get(workflowRunId) as { workflow_name: string } | undefined;
  if (!pr) return 0;
  const total = (db.prepare('SELECT COUNT(*) AS n FROM workflow_jobs WHERE workflow_name = ?')
    .get(pr.workflow_name) as { n: number }).n;
  if (total <= 0) return 0;
  // Latest run per member job in this workflow run. UUID ids aren't ordered, so
  // pick by rowid; across repeatUntilStable cycles this naturally tracks the
  // current cycle's run for each job.
  const rows = db.prepare(`
    SELECT status, progress FROM runs r
    WHERE workflow_run_id = ?
      AND rowid = (SELECT MAX(rowid) FROM runs
                   WHERE workflow_run_id = r.workflow_run_id AND job_name = r.job_name)
  `).all(workflowRunId) as { status: RunStatus; progress: number }[];
  let fraction = 0;
  for (const r of rows) {
    fraction += TERMINAL_RUN_STATUSES.has(r.status)
      ? 1
      : Math.max(0, Math.min(100, r.progress)) / 100;
  }
  const pct = Math.max(0, Math.min(100, (fraction / total) * 100));
  if (message === undefined) {
    db.prepare('UPDATE workflow_runs SET progress = ? WHERE id = ?').run(Math.round(pct), workflowRunId);
  } else {
    setWorkflowProgress(workflowRunId, pct, message);
  }
  return pct;
}

export function finishWorkflowRun(id: string, status: WorkflowRunStatus): void {
  db.prepare(`
    UPDATE workflow_runs SET
      status = ?,
      finished_at = datetime('now'),
      duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER),
      progress = CASE WHEN ? = 'success' THEN 100 ELSE progress END
    WHERE id = ?
  `).run(status, status, id);
}

export function getWorkflowRun(id: string): WorkflowRunRow | undefined {
  return db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as WorkflowRunRow | undefined;
}

export function listWorkflowRunsForWorkflow(name: string, limit = 50): WorkflowRunRow[] {
  return db.prepare('SELECT * FROM workflow_runs WHERE workflow_name = ? ORDER BY started_at DESC LIMIT ?')
    .all(name, limit) as WorkflowRunRow[];
}

export function listRecentWorkflowRuns(limit = 50): WorkflowRunRow[] {
  return db.prepare('SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT ?').all(limit) as WorkflowRunRow[];
}

export function lastWorkflowRunForWorkflow(name: string): WorkflowRunRow | undefined {
  return db.prepare('SELECT * FROM workflow_runs WHERE workflow_name = ? ORDER BY started_at DESC LIMIT 1')
    .get(name) as WorkflowRunRow | undefined;
}

/** Member job runs of a workflow run, in start order (for drill-down). */
export function listRunsForWorkflowRun(workflowRunId: string): RunRow[] {
  return db.prepare('SELECT * FROM runs WHERE workflow_run_id = ? ORDER BY started_at')
    .all(workflowRunId) as RunRow[];
}

export function hasActiveWorkflowRun(name: string): boolean {
  return (db.prepare(`SELECT COUNT(*) AS n FROM workflow_runs WHERE workflow_name = ? AND status = 'running'`)
    .get(name) as { n: number }).n > 0;
}

/** On daemon startup, close workflow runs orphaned by a crash. */
export function reapOrphanWorkflowRuns(): number {
  return db.prepare(`
    UPDATE workflow_runs SET status = 'cancelled', finished_at = datetime('now')
    WHERE status = 'running'
  `).run().changes;
}

/** Member-job work items still in the retry window = "retryable work left" (for repeatUntilStable). */
export function workflowRetryableCount(jobNames: string[], minAttempts: number): number {
  if (jobNames.length === 0) return 0;
  const ph = jobNames.map(() => '?').join(',');
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM work_items WHERE job_name IN (${ph}) AND status = 'failed' AND attempts < ?`,
  ).get(...jobNames, minAttempts) as { n: number }).n;
}

// ---- workflow framework logs ----

export function addWorkflowLog(workflowRunId: string, message: string, level: LogLevel = 'info'): void {
  db.prepare('INSERT INTO workflow_run_logs (workflow_run_id, level, message) VALUES (?, ?, ?)')
    .run(workflowRunId, level, message);
}

export function getWorkflowLogs(workflowRunId: string, afterId = 0): { id: number; ts: string; level: LogLevel; message: string }[] {
  return db.prepare('SELECT id, ts, level, message FROM workflow_run_logs WHERE workflow_run_id = ? AND id > ? ORDER BY id')
    .all(workflowRunId, afterId) as { id: number; ts: string; level: LogLevel; message: string }[];
}

// ════════════════════════ services (shared rate + quota) ════════════════════════

// On re-sync, code re-seeds the limits ONLY while the user hasn't taken them over.
// Once `limits_overridden = 1` (a dashboard edit, below), the three limit columns
// are preserved from the existing row so code-sync never clobbers a user override
// — the same reconcile the user-owned `enabled` flag gets. description/paid are
// code-owned and always refreshed.
const upsertServiceStmt = db.prepare(`
  INSERT INTO services (name, description, rate_per_minute, daily_cap, monthly_cap, paid)
  VALUES (@name, @description, @rate, @daily, @monthly, @paid)
  ON CONFLICT(name) DO UPDATE SET
    description     = excluded.description,
    paid            = excluded.paid,
    rate_per_minute = CASE WHEN limits_overridden = 1 THEN rate_per_minute ELSE excluded.rate_per_minute END,
    daily_cap       = CASE WHEN limits_overridden = 1 THEN daily_cap       ELSE excluded.daily_cap       END,
    monthly_cap     = CASE WHEN limits_overridden = 1 THEN monthly_cap     ELSE excluded.monthly_cap     END
`);

export function syncService(def: ServiceDefinition): void {
  upsertServiceStmt.run({
    name: def.name,
    description: def.description ?? '',
    rate: def.ratePerMinute ?? null,
    daily: def.dailyCap ?? null,
    monthly: def.monthlyCap ?? null,
    paid: def.paid ? 1 : 0,
  });
}

export interface ServiceRow {
  name: string;
  description: string;
  rate_per_minute: number | null;
  daily_cap: number | null;
  monthly_cap: number | null;
  paid: number;
  limits_overridden: number;
  created_at: string;
}

export function getServiceRow(name: string): ServiceRow | undefined {
  return db.prepare('SELECT * FROM services WHERE name = ?').get(name) as ServiceRow | undefined;
}

export function listServices(): ServiceRow[] {
  return db.prepare('SELECT * FROM services ORDER BY name').all() as ServiceRow[];
}

export interface ServiceLimits {
  rate_per_minute: number | null;
  daily_cap: number | null;
  monthly_cap: number | null;
}

const updateServiceLimitsStmt = db.prepare(`
  UPDATE services
     SET rate_per_minute = @rate, daily_cap = @daily, monthly_cap = @monthly, limits_overridden = 1
   WHERE name = @name
`);

/**
 * Persist a USER override of a service's limits (from the dashboard). Sets the
 * three limit columns and flips `limits_overridden` so a later code-sync keeps
 * them. A `null` means "no throttle / no cap". Returns the updated row, or
 * undefined if the service doesn't exist (no row touched).
 */
export function updateServiceLimits(name: string, limits: ServiceLimits): ServiceRow | undefined {
  const info = updateServiceLimitsStmt.run({
    name,
    rate: limits.rate_per_minute,
    daily: limits.daily_cap,
    monthly: limits.monthly_cap,
  });
  if (info.changes === 0) return undefined;
  return getServiceRow(name);
}

export function recordServiceCall(service: string): void {
  db.prepare('INSERT INTO service_usage (service) VALUES (?)').run(service);
}

/**
 * Seed N service_usage rows for a service (one-time backfill when migrating a
 * job's metering from the per-job `job_usage` meter onto the shared service
 * meter). Idempotent topping-up is the caller's job: pass the DIFFERENCE you
 * want to add, not an absolute target. Inserts in a single transaction.
 */
export function backfillServiceUsage(service: string, count: number): void {
  if (count <= 0) return;
  const insert = db.prepare('INSERT INTO service_usage (service) VALUES (?)');
  const tx = db.transaction((n: number) => { for (let i = 0; i < n; i++) insert.run(service); });
  tx(count);
}

export function serviceCallsToday(service: string): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM service_usage WHERE service = ? AND ts >= datetime('now','start of day')",
  ).get(service) as { n: number }).n;
}

export function serviceCallsThisMonth(service: string): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM service_usage WHERE service = ? AND ts >= datetime('now','start of month')",
  ).get(service) as { n: number }).n;
}

export function serviceCallsInLastSeconds(service: string, seconds: number): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM service_usage WHERE service = ? AND ts >= datetime('now', ?)",
  ).get(service, `-${seconds} seconds`) as { n: number }).n;
}

const _countLast60 = db.prepare(
  "SELECT COUNT(*) AS n FROM service_usage WHERE service = ? AND ts >= datetime('now','-60 seconds')",
);
const _insertServiceUsage = db.prepare('INSERT INTO service_usage (service) VALUES (?)');
const _reserveSlotTx = db.transaction((service: string, ratePerMinute: number): boolean => {
  const n = (_countLast60.get(service) as { n: number }).n;
  if (n >= ratePerMinute) return false;
  _insertServiceUsage.run(service);
  return true;
});

/**
 * Atomically try to reserve a per-minute rate slot for a service: counts calls in
 * the trailing 60s and, if under the limit, records one — all in a single IMMEDIATE
 * transaction so concurrent job processes can't both slip through. Returns true if
 * the slot was acquired (caller proceeds), false if the caller should wait + retry.
 */
export function tryReserveServiceSlot(service: string, ratePerMinute: number): boolean {
  return _reserveSlotTx.immediate(service, ratePerMinute) as boolean;
}

const _maxGapMs = db.prepare(
  "SELECT (julianday('now') - julianday(MAX(ts))) * 86400000 AS gap FROM service_usage WHERE service = ?",
);
const _reserveIntervalTx = db.transaction((service: string, minIntervalMs: number): boolean => {
  const row = _maxGapMs.get(service) as { gap: number | null };
  if (row.gap !== null && row.gap < minIntervalMs) return false;
  _insertServiceUsage.run(service);
  return true;
});

/**
 * Atomically reserve a slot that enforces a MINIMUM GAP since the service's last
 * call (fixed spacing, not a burst-y rate). Returns true if at least
 * `minIntervalMs` has elapsed since the last recorded call (and records this one),
 * false if the caller should wait + retry. Single IMMEDIATE transaction so
 * concurrent job processes can't both slip through.
 */
export function tryReserveMinInterval(service: string, minIntervalMs: number): boolean {
  return _reserveIntervalTx.immediate(service, minIntervalMs) as boolean;
}

// ─────────────────── Read-only DB browser (dashboard) ───────────────────
// A generic, strictly READ-ONLY view of the SQLite tables for ad-hoc browsing
// from the dashboard, so the local DB can be inspected without building a
// bespoke query/endpoint per question. There is NO write path here: only SELECT
// + PRAGMA table_info run, and the table name (which can't be parameterized) is
// whitelisted against the live schema before it's ever interpolated — so an
// arbitrary or malicious name can't reach the query.

/** All user-defined table names (excludes SQLite-internal `sqlite_*` tables). */
export function listDbTables(): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

/** True iff `name` is a real user table — the guard for every dynamic-table query. */
function isKnownTable(name: string): boolean {
  return listDbTables().includes(name);
}

export interface TablePage {
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Read one page of rows from a table. READ-ONLY by construction: the table name
 * is rejected (→ null) unless it's a known table, `limit` is clamped to [1,500],
 * `offset` is non-negative, and only a plain `SELECT *` runs. Rows are ordered by
 * `rowid` for stable paging (all tables here are rowid tables).
 */
export function browseTable(table: string, limit = 50, offset = 0): TablePage | null {
  if (!isKnownTable(table)) return null;
  const lim = Math.max(1, Math.min(500, Math.floor(limit) || 50));
  const off = Math.max(0, Math.floor(offset) || 0);
  // Safe to interpolate: `table` is whitelisted above; double-quoted as an identifier.
  const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
  const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid LIMIT ? OFFSET ?`).all(lim, off) as Record<
    string,
    unknown
  >[];
  return { table, columns, rows, total, limit: lim, offset: off };
}
