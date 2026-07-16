import { randomUUID } from 'node:crypto';
import { db } from '../index.js';
import { buildDag } from '../../core/dag.js';
import type {
  LogLevel,
  WorkflowDefinition,
  WorkflowRunRow,
  WorkflowRunStatus,
  RunRow,
  RunStatus,
  RunTrigger,
} from '../../core/types.js';

// ════════════════════════════════ workflows ════════════════════════════════

// On re-sync, code re-seeds the cron `schedule` ONLY while the user hasn't taken it
// over. Once `schedule_overridden = 1` (a dashboard edit, see updateWorkflowSchedule),
// the schedule is preserved from the existing row so code-sync never clobbers a user
// override — the same reconcile the user-owned `enabled` flag and the service limits
// get. description is code-owned and always refreshed.
const upsertWorkflowStmt = db.prepare(`
  INSERT INTO workflows (name, description, category, idempotency_note, schedule, enabled, max_concurrency, notify_enabled)
  VALUES (@name, @description, @category, @idempotencyNote, @schedule, 1, @maxConcurrency, @notifyEnabled)
  ON CONFLICT(name) DO UPDATE SET
    description      = excluded.description,
    category         = excluded.category,
    idempotency_note = excluded.idempotency_note,
    schedule        = CASE WHEN schedule_overridden = 1 THEN schedule ELSE excluded.schedule END,
    max_concurrency = CASE WHEN max_concurrency_overridden = 1 THEN max_concurrency ELSE excluded.max_concurrency END,
    notify_enabled  = CASE WHEN notify_enabled_overridden = 1 THEN notify_enabled ELSE excluded.notify_enabled END
`);

/** Upsert a workflow + REPLACE its membership/edges. `enabled`, an overridden
 *  `schedule`, an overridden `max_concurrency`, and an overridden `notify_enabled`
 *  are preserved across the sync. `category` and `idempotency_note` are
 *  manifest-owned and always refreshed from code (no override, unlike the other
 *  three). */
export function syncWorkflow(def: WorkflowDefinition): void {
  const tx = db.transaction(() => {
    upsertWorkflowStmt.run({
      name: def.name,
      description: def.description ?? '',
      category: def.category ?? 'uncategorized',
      idempotencyNote: def.idempotencyNote ?? '',
      schedule: def.schedule ?? null,
      maxConcurrency: def.maxConcurrency ?? null,
      notifyEnabled: def.notifyEnabled === false ? 0 : 1,
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
  category: string;
  idempotency_note: string;
  schedule: string | null;
  enabled: number;
  schedule_overridden: number;
  schedule_overridden_at: string | null;
  max_concurrency: number | null;
  max_concurrency_overridden: number;
  max_concurrency_overridden_at: string | null;
  notify_enabled: number;
  notify_enabled_overridden: number;
  notify_enabled_overridden_at: string | null;
  certified: number;
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

/**
 * Persist a USER override of a workflow's cron schedule (from the dashboard, T135).
 * Sets `schedule` and flips `schedule_overridden = 1` so a later code-sync keeps the
 * user's value — the same ownership reconcile `enabled`/service limits get. An
 * empty/blank schedule clears it to NULL = manual-only. Returns the updated row, or
 * undefined if the workflow doesn't exist (no row touched).
 */
export function updateWorkflowSchedule(name: string, schedule: string | null): WorkflowRow | undefined {
  const normalised = schedule && schedule.trim() !== '' ? schedule.trim() : null;
  const info = db
    .prepare("UPDATE workflows SET schedule = ?, schedule_overridden = 1, schedule_overridden_at = datetime('now') WHERE name = ?")
    .run(normalised, name);
  if (info.changes === 0) return undefined;
  return getWorkflow(name);
}

/**
 * Persist a USER override of a workflow's bounded-parallelism cap (from the
 * dashboard, T169). Sets `max_concurrency` and flips `max_concurrency_overridden = 1`
 * so a later code-sync keeps the user's value — the same ownership reconcile
 * `enabled`/`schedule`/service limits get. `n` must be a positive integer ≥ 1 OR
 * exactly `0` (the unlimited sentinel, T201 — means "no cap, launch all ready stages").
 * Callers validate; this throws on any other value as a defensive backstop. Returns
 * the updated row, or undefined if the workflow doesn't exist (no row touched).
 */
export function updateWorkflowConcurrency(name: string, n: number): WorkflowRow | undefined {
  if (!Number.isInteger(n) || (n !== 0 && n < 1)) {
    throw new Error(`maxConcurrency must be a positive integer ≥ 1 or 0 (unlimited), got ${n}`);
  }
  const info = db
    .prepare("UPDATE workflows SET max_concurrency = ?, max_concurrency_overridden = 1, max_concurrency_overridden_at = datetime('now') WHERE name = ?")
    .run(n, name);
  if (info.changes === 0) return undefined;
  return getWorkflow(name);
}

/**
 * Persist a USER override of whether a workflow sends the run-end aggregate push
 * notification (from the dashboard, T285). Sets `notify_enabled` and flips
 * `notify_enabled_overridden = 1` so a later code-sync keeps the user's value —
 * the same ownership reconcile `enabled`/`schedule`/`max_concurrency` get. Returns
 * the updated row, or undefined if the workflow doesn't exist (no row touched).
 */
export function updateWorkflowNotifyEnabled(name: string, enabled: boolean): WorkflowRow | undefined {
  const info = db
    .prepare("UPDATE workflows SET notify_enabled = ?, notify_enabled_overridden = 1, notify_enabled_overridden_at = datetime('now') WHERE name = ?")
    .run(enabled ? 1 : 0, name);
  if (info.changes === 0) return undefined;
  return getWorkflow(name);
}

/**
 * Persist a plain USER-set "certified" flag on a workflow (T497) — a
 * reviewed-and-settled marker distinct from the harness's own per-task overlays.
 * Unlike `enabled`/`schedule`/`max_concurrency`/`notify_enabled`, this has no
 * code/manifest source to reconcile against, so there is no `_overridden`
 * companion column and `syncWorkflow`'s upsert never touches it. Returns the
 * updated row, or undefined if the workflow doesn't exist (no row touched).
 */
export function setWorkflowCertified(name: string, certified: boolean): WorkflowRow | undefined {
  const info = db.prepare('UPDATE workflows SET certified = ? WHERE name = ?').run(certified ? 1 : 0, name);
  if (info.changes === 0) return undefined;
  return getWorkflow(name);
}

export function getWorkflowJobs(name: string): { job_name: string; depends_on: string[] }[] {
  const rows = db.prepare('SELECT job_name, depends_on FROM workflow_jobs WHERE workflow_name = ?')
    .all(name) as { job_name: string; depends_on: string }[];
  const members = rows.map((r) => ({ job_name: r.job_name, depends_on: JSON.parse(r.depends_on) as string[] }));
  // SQLite has no ORDER BY here, so rows arrive in the table's PK-index order
  // (alphabetical by job_name within a workflow) rather than DAG order — reorder
  // topologically so every consumer (e.g. the workflow-run IO panel's stage
  // filter bar) reflects the workflow's actual dependency order. Falls back to
  // the raw row order if the DAG is malformed (duplicate member / a depends_on
  // referencing a non-member) so this function itself never throws.
  try {
    const dag = buildDag(members.map((m) => ({ job: m.job_name, dependsOn: m.depends_on })));
    const order = new Map(dag.waves.flat().map((job, i) => [job, i]));
    return [...members].sort((a, b) => (order.get(a.job_name) ?? 0) - (order.get(b.job_name) ?? 0));
  } catch {
    return members;
  }
}

/**
 * Open a workflow run. `runLimit`/`selectedRoots` (T094) record a MANUAL run's
 * cap on originating inputs and the frozen allowlist of selected root keys; both
 * default to null = unlimited (scheduled runs never set them). The allowlist is
 * frozen ONCE here and read identically by every member child (and reused across
 * repeatUntilStable cycles).
 */
export function createWorkflowRun(
  workflowName: string,
  trigger: RunTrigger,
  runLimit: number | null = null,
  selectedRoots: string[] | null = null,
): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO workflow_runs (id, workflow_name, status, trigger, started_at, run_limit, selected_roots)
    VALUES (?, ?, 'running', ?, datetime('now'), ?, ?)
  `).run(id, workflowName, trigger, runLimit, selectedRoots ? JSON.stringify(selectedRoots) : null);
  return id;
}

/**
 * The frozen originating-input allowlist for a workflow run (T094), or null when
 * the run is unlimited (no limit, or an unknown id). Read once per member child
 * (via LOCALJOBS_WORKFLOW_RUN_ID) to build `ctx.selectedRoots()`/`rootAllowed()`.
 */
export function getWorkflowRunRoots(workflowRunId: string): string[] | null {
  const row = db.prepare('SELECT selected_roots FROM workflow_runs WHERE id = ?')
    .get(workflowRunId) as { selected_roots: string | null } | undefined;
  if (!row || row.selected_roots == null) return null;
  try {
    const parsed = JSON.parse(row.selected_roots) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
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
 * The denominator is the workflow's total stage count (its member jobs); progress
 * counts ONLY completed stages — a member in a terminal state contributes a full
 * stage (1), while a still-running or not-yet-started member contributes 0 (no
 * partial credit for in-flight work). So with N stages the bar stays at 0% until
 * the first stage finishes, then steps in 100/N increments per completed stage
 * (e.g. 4 jobs -> 0/25/50/75/100). Called whenever a member settles (via
 * `setProgress`) or a stage finishes; an in-flight member's mid-run progress no
 * longer moves the bar.
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
  // Count ONLY completed (terminal) stages — no partial credit for a member
  // that is still running, so the bar steps in whole 100/N increments.
  let completed = 0;
  for (const r of rows) {
    if (TERMINAL_RUN_STATUSES.has(r.status)) completed += 1;
  }
  const pct = Math.max(0, Math.min(100, (completed / total) * 100));
  if (message === undefined) {
    db.prepare('UPDATE workflow_runs SET progress = ? WHERE id = ?').run(Math.round(pct), workflowRunId);
  } else {
    setWorkflowProgress(workflowRunId, pct, message);
  }
  return pct;
}

/**
 * Extended workflow run status. Adds `'skipped'` for a noop run — one where
 * the workflow executed but did NO actual item work (all stages had nothing to
 * process). Distinct from `'partial'` (some stages actually failed). T258.
 */
export type FinalWorkflowRunStatus = WorkflowRunStatus | 'skipped';

export function finishWorkflowRun(id: string, status: FinalWorkflowRunStatus): void {
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

/**
 * Member job runs of a workflow run, in creation order (for drill-down).
 * Ordered by `started_at, rowid` — the `rowid` tiebreaker is essential (T112):
 * `started_at` is only second-granularity, so during fast `repeatUntilStable`
 * cycling two runs of the SAME job (an earlier cycle's settled run and the current
 * cycle's fresh `running` run) can share a second. Without the tiebreaker their
 * order is undefined and the dashboard's "latest run per stage" (last-write-wins)
 * could pick the OLD settled run over the new running one — the succeeded→running→
 * succeeded status flicker. `rowid` increases monotonically with creation, so the
 * genuinely-latest run always sorts last.
 */
export function listRunsForWorkflowRun(workflowRunId: string): RunRow[] {
  return db.prepare('SELECT * FROM runs WHERE workflow_run_id = ? ORDER BY started_at, rowid')
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

/** A cheap snapshot of a workflow's member work-item ledger (T112), used to decide
 *  whether a `repeatUntilStable` cycle actually advanced anything: total ledger
 *  rows, the SUM of their attempt counts, and how many are still retryable. */
export interface WorkflowProgressSignature {
  items: number;
  attempts: number;
  retryable: number;
}

/** Snapshot the member work-item ledger for no-forward-progress detection (T112). */
export function workflowProgressSignature(jobNames: string[], minAttempts: number): WorkflowProgressSignature {
  if (jobNames.length === 0) return { items: 0, attempts: 0, retryable: 0 };
  const ph = jobNames.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT COUNT(*) AS items, COALESCE(SUM(attempts), 0) AS attempts FROM work_items WHERE job_name IN (${ph})`,
  ).get(...jobNames) as { items: number; attempts: number };
  return { items: row.items, attempts: row.attempts, retryable: workflowRetryableCount(jobNames, minAttempts) };
}

/**
 * Whether a `repeatUntilStable` cycle made NO forward progress versus the previous
 * cycle (T112): the ledger row count and total attempts are unchanged AND the
 * retryable count did not drop. When true, continuing to cycle would just re-run
 * every stage to `maxCycles` for nothing — e.g. a genuinely-unfindable input frozen
 * below `maxAttempts` that is counted retryable every cycle yet never actually
 * advances. Pure (no DB) so it's directly unit-testable. `null` prev (first cycle)
 * is never "no progress".
 */
export function noForwardProgress(
  prev: WorkflowProgressSignature | null,
  cur: WorkflowProgressSignature,
): boolean {
  if (!prev) return false;
  return cur.items === prev.items && cur.attempts === prev.attempts && cur.retryable >= prev.retryable;
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
