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
 * Upsert a job definition. A job is only ever a workflow member (T037/T070), so
 * it carries no schedule or enable toggle — those live on the workflow. Only the
 * job's identity + execution params (timeout/retries) are synced here.
 */
const upsertJobStmt = db.prepare(`
  INSERT INTO jobs (name, description, timeout_ms, max_retries)
  VALUES (@name, @description, @timeout_ms, @max_retries)
  ON CONFLICT(name) DO UPDATE SET
    description = excluded.description,
    timeout_ms  = excluded.timeout_ms,
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
  max_retries: number;
  created_at: string;
}

export function getJob(name: string): JobRow | undefined {
  return db.prepare('SELECT * FROM jobs WHERE name = ?').get(name) as JobRow | undefined;
}

export function listJobs(): JobRow[] {
  return db.prepare('SELECT * FROM jobs ORDER BY name').all() as JobRow[];
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
  /** Originating input this item descends from (T094). For a root, == item_key. */
  root_key: string | null;
  /** Immediate upstream item this was derived from (fan-out); NULL for roots. */
  parent_key: string | null;
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

/**
 * Resolve an item's originating-input `root_key` (T094), evaluated in order:
 *  1. an explicit `rootKey` opt wins;
 *  2. else inherit the parent row's `root_key` (looked up by `parentJob`, default
 *     this job), falling back to `parentKey` itself if the parent row is missing;
 *  3. else the item is its own root → `item_key`.
 * So same-key stages (perfumes) need NO lineage args (rule 3); only key-changing /
 * fan-out stages (places enrich/llm) pass `rootKey`/`parentKey`.
 */
function resolveRootKey(
  jobName: string,
  itemKey: string,
  opts: { rootKey?: string; parentKey?: string; parentJob?: string },
): string {
  if (opts.rootKey) return opts.rootKey;
  if (opts.parentKey) {
    const parent = getWorkItem(opts.parentJob ?? jobName, opts.parentKey);
    return parent?.root_key ?? opts.parentKey;
  }
  return itemKey;
}

/**
 * Record (upsert) the outcome of processing a work item. `detail` is JSON-serialized.
 * Lineage opts (T094) are all optional + back-compatible: with none given the item
 * is its own root (`root_key = item_key`). Pass `rootKey` (or `parentKey`/`parentJob`
 * to inherit) only on a stage that changes keys or fans out, so a run-limit can
 * bound originating inputs and still run all their descendants.
 */
export function markWorkItem(
  jobName: string,
  itemKey: string,
  status: WorkStatus,
  opts: {
    attempts?: number;
    detail?: unknown;
    rootKey?: string;
    parentKey?: string;
    parentJob?: string;
    /**
     * The workflow run advancing this item (T139). Defaults to the child's
     * `LOCALJOBS_WORKFLOW_RUN_ID` env (set by the executor for every workflow
     * member), so existing job call sites need no change. When present, a
     * `work_item_runs` linkage row is recorded so the run page can scope its
     * Input→Output panel to this run; `null` (a standalone run) records nothing.
     * Pass explicitly only for testing.
     */
    workflowRunId?: string | null;
  } = {},
): void {
  const detail = opts.detail === undefined ? null : JSON.stringify(opts.detail);
  const rootKey = resolveRootKey(jobName, itemKey, opts);
  const parentKey = opts.parentKey ?? null;
  db.prepare(`
    INSERT INTO work_items (job_name, item_key, status, attempts, detail, root_key, parent_key)
    VALUES (@job, @key, @status, @attempts, @detail, @root, @parent)
    ON CONFLICT(job_name, item_key) DO UPDATE SET
      status = excluded.status,
      attempts = excluded.attempts,
      detail = excluded.detail,
      root_key = excluded.root_key,
      parent_key = excluded.parent_key,
      updated_at = datetime('now')
  `).run({ job: jobName, key: itemKey, status, attempts: opts.attempts ?? 1, detail, root: rootKey, parent: parentKey });

  // Run→work-item attribution (T139): when this item was advanced inside a
  // workflow run, record which run touched it (idempotent per run+item) so the
  // run-page IO panel can be scoped to THIS run rather than the global ledger.
  const workflowRunId = opts.workflowRunId === undefined
    ? (process.env.LOCALJOBS_WORKFLOW_RUN_ID || null)
    : opts.workflowRunId;
  if (workflowRunId) {
    db.prepare(`
      INSERT INTO work_item_runs (workflow_run_id, job_name, item_key, root_key)
      VALUES (@run, @job, @key, @root)
      ON CONFLICT(workflow_run_id, job_name, item_key) DO UPDATE SET
        root_key = excluded.root_key,
        at = datetime('now')
    `).run({ run: workflowRunId, job: jobName, key: itemKey, root: rootKey });
  }
}

/**
 * Whether a root still has outstanding work anywhere across a workflow's member
 * jobs (T094) — true if ANY ledger row for that root, in any of `jobNames`, is not
 * yet done (not success/ignored and not a failure past the retry budget). One
 * indexed query over (job_name, root_key).
 */
function rootHasOutstandingWork(jobNames: string[], rootKey: string, minAttempts: number): boolean {
  if (jobNames.length === 0) return false;
  const ph = jobNames.map(() => '?').join(',');
  const row = db.prepare(`
    SELECT 1 FROM work_items
     WHERE job_name IN (${ph}) AND root_key = ?
       AND NOT (status IN ('success','ignored') OR (status = 'failed' AND attempts >= ?))
     LIMIT 1
  `).get(...jobNames, rootKey, minAttempts);
  return !!row;
}

/**
 * Has this root propagated all the way to a TERMINAL stage (the last DAG wave)? —
 * true if any terminal-job row for that root is in a DONE state (success/ignored,
 * or failed past the retry budget = reached terminal but permanently failed there).
 * Used by {@link selectPendingRoots} to decide a root is fully processed (T163).
 */
function rootReachedTerminal(terminalJobs: string[], rootKey: string, minAttempts: number): boolean {
  if (terminalJobs.length === 0) return false;
  const ph = terminalJobs.map(() => '?').join(',');
  const row = db.prepare(`
    SELECT 1 FROM work_items
     WHERE job_name IN (${ph}) AND root_key = ?
       AND (status IN ('success','ignored') OR (status = 'failed' AND attempts >= ?))
     LIMIT 1
  `).get(...terminalJobs, rootKey, minAttempts);
  return !!row;
}

/**
 * Does this root carry a "gave up" marker anywhere — an `ignored` row OR a
 * retry-exhausted (`failed` past the budget) row at any stage (T163)? Such a root
 * is stuck/unprogressable BELOW the terminal stage (it can't advance further), so
 * once it has no retryable outstanding work it is DONE, not perpetually pending —
 * this is what stops the selector livelocking on a root that can never reach the
 * terminal. (Distinct from a merely resolved-but-not-yet-attempted downstream
 * root, which has only success rows and no such marker → genuinely pending.)
 */
function rootHasTerminalBlocker(jobNames: string[], rootKey: string, minAttempts: number): boolean {
  if (jobNames.length === 0) return false;
  const ph = jobNames.map(() => '?').join(',');
  const row = db.prepare(`
    SELECT 1 FROM work_items
     WHERE job_name IN (${ph}) AND root_key = ?
       AND (status = 'ignored' OR (status = 'failed' AND attempts >= ?))
     LIMIT 1
  `).get(...jobNames, rootKey, minAttempts);
  return !!row;
}

/**
 * Is a root still PENDING for a limited run (T163)? — i.e. has it NOT yet been
 * fully processed through the pipeline. The corrected semantics (the T163 fix):
 * "pending" is defined by propagation through the TERMINAL stage, not merely past
 * the entry stage. In order:
 *  1. any retryable (not-done) row anywhere → still pending (work to retry);
 *  2. else if it reached a terminal stage (a done terminal row) → fully done;
 *  3. else if it carries a gave-up marker (ignored / retry-exhausted at any stage)
 *     and has no retryable work → stuck below the terminal, treat as done so the
 *     selector can't livelock on an unprogressable root;
 *  4. else it has unattempted downstream work (e.g. a resolved-but-not-yet-enriched
 *     place: entry succeeded, a later stage has NO row at all) → pending.
 * Step 4 is the bug this fixes: previously a root whose later stages simply hadn't
 * been attempted (no row) looked "fully done" and was never selected.
 */
export function isRootPending(
  members: string[],
  terminalJobs: string[],
  rootKey: string,
  minAttempts: number,
): boolean {
  if (rootHasOutstandingWork(members, rootKey, minAttempts)) return true;     // (1)
  if (rootReachedTerminal(terminalJobs, rootKey, minAttempts)) return false;  // (2)
  if (rootHasTerminalBlocker(members, rootKey, minAttempts)) return false;    // (3)
  return true;                                                                // (4)
}

/**
 * Select the first `n` PENDING originating-input roots for a limited workflow run
 * (T094, corrected by T163), preserving `candidateRootsInOrder` order (the root
 * stage's `inputKeys()`, which is stable input-file order → deterministic
 * selection). A root is pending until it has propagated through a TERMINAL stage
 * (see {@link isRootPending}) — NOT merely past the entry stage — so a root whose
 * downstream stages simply haven't been attempted yet (e.g. resolved-but-not-
 * enriched) is correctly selected, while a fully-propagated or unprogressable-stuck
 * root is skipped. `terminalJobs` is the DAG's last wave. `n <= 0` selects none.
 */
export function selectPendingRoots(
  members: string[],
  terminalJobs: string[],
  candidateRootsInOrder: string[],
  n: number,
  minAttempts: number,
): string[] {
  if (n <= 0) return [];
  const selected: string[] = [];
  for (const root of candidateRootsInOrder) {
    if (isRootPending(members, terminalJobs, root, minAttempts)) selected.push(root);
    if (selected.length >= n) break;
  }
  return selected;
}

/**
 * Input→output mapping across a workflow's first and last stages (T095, T139).
 *
 * When `workflowRunId` is given the mapping is genuinely RUN-SCOPED: it lists only
 * the originating roots THIS run advanced (from the `work_item_runs` linkage —
 * recorded by {@link markWorkItem}), then resolves each root's input (first-wave
 * ledger row) and output (last-wave ledger row) from the cumulative `work_items`
 * ledger. Resolving outputs from the ledger means an output produced in an EARLIER
 * run still shows for a root this run touched. If the run has NO linkage rows (an
 * OLD run created before this feature, or a re-run that advanced nothing new) the
 * result is empty with `scoped: false` — it does NOT fall back to the global ledger.
 *
 * With NO `workflowRunId` (or `null`) it keeps the legacy un-scoped behaviour:
 * every first-wave input joined to its output by root_key, `scoped: false`.
 *
 * Fan-out (1 input → many outputs) is collapsed to the first matching output.
 * For the example workflows (perfumes: all stages share item_key; places: later
 * stages use root_key = CID from the first stage) this join is exact.
 */
export interface IoRow {
  inputJob: string;
  inputKey: string;
  inputStatus: string;
  inputDetail: unknown;
  outputJob: string | null;
  outputKey: string | null;
  outputStatus: string | null;
  outputDetail: unknown;
}

export interface IoResult {
  rows: IoRow[];
  /** True when the rows are scoped to a specific run's advanced items. */
  scoped: boolean;
}

type LedgerRow = { job_name: string; item_key: string; status: string; detail: string | null; root_key: string | null };

function toIoRow(input: LedgerRow | undefined, out: LedgerRow | undefined, rootFallback: string, firstJob: string): IoRow {
  return {
    inputJob: input?.job_name ?? firstJob,
    inputKey: input?.item_key ?? rootFallback,
    inputStatus: input?.status ?? 'unknown',
    inputDetail: input?.detail != null ? (JSON.parse(input.detail) as unknown) : null,
    outputJob: out?.job_name ?? null,
    outputKey: out?.item_key ?? null,
    outputStatus: out?.status ?? null,
    outputDetail: out?.detail != null ? (JSON.parse(out.detail) as unknown) : null,
  };
}

export function workItemIoRows(
  firstWaveJobs: string[],
  lastWaveJobs: string[],
  workflowRunId?: string | null,
): IoResult {
  if (firstWaveJobs.length === 0) return { rows: [], scoped: false };

  // Build a root_key → first matching output map from the last wave (cumulative).
  const outputByRoot = new Map<string, LedgerRow>();
  if (lastWaveJobs.length > 0) {
    const ph2 = lastWaveJobs.map(() => '?').join(',');
    const outputs = db.prepare(
      `SELECT job_name, item_key, status, detail, root_key FROM work_items WHERE job_name IN (${ph2}) ORDER BY item_key`,
    ).all(...lastWaveJobs) as LedgerRow[];
    for (const o of outputs) {
      const rk = o.root_key ?? o.item_key;
      if (!outputByRoot.has(rk)) outputByRoot.set(rk, o);
    }
  }

  const ph1 = firstWaveJobs.map(() => '?').join(',');

  // Run-scoped (T139): only the roots THIS run advanced.
  if (workflowRunId != null) {
    const roots = db.prepare(
      'SELECT DISTINCT root_key FROM work_item_runs WHERE workflow_run_id = ? AND root_key IS NOT NULL ORDER BY root_key',
    ).all(workflowRunId) as { root_key: string }[];
    if (roots.length === 0) return { rows: [], scoped: false };

    // Resolve each root's first-wave input row from the cumulative ledger.
    const inputByRoot = new Map<string, LedgerRow>();
    const firstInputs = db.prepare(
      `SELECT job_name, item_key, status, detail, root_key FROM work_items WHERE job_name IN (${ph1}) ORDER BY item_key`,
    ).all(...firstWaveJobs) as LedgerRow[];
    for (const i of firstInputs) {
      const rk = i.root_key ?? i.item_key;
      if (!inputByRoot.has(rk)) inputByRoot.set(rk, i);
    }

    const rows: IoRow[] = [];
    for (const { root_key: root } of roots) {
      const input = inputByRoot.get(root);
      const out = outputByRoot.get(root);
      if (!input && !out) continue; // root with neither input nor output ledger row — skip
      rows.push(toIoRow(input, out, root, firstWaveJobs[0]));
    }
    return { rows, scoped: true };
  }

  // Legacy un-scoped: every first-wave input joined to its output by root_key.
  const inputs = db.prepare(
    `SELECT job_name, item_key, status, detail, root_key FROM work_items WHERE job_name IN (${ph1}) ORDER BY item_key`,
  ).all(...firstWaveJobs) as LedgerRow[];
  const rows = inputs.map((r) => toIoRow(r, outputByRoot.get(r.item_key), r.item_key, firstWaveJobs[0]));
  return { rows, scoped: false };
}

/**
 * Whether ANY workflow run of `workflowName` has ever recorded `work_item_runs`
 * linkage (T139). Used to distinguish, for a run with no linkage of its own, an
 * OLD run created before the feature (the workflow has NO linkage at all) from a
 * re-run that simply advanced nothing new (the workflow HAS linkage from other runs).
 */
export function workflowHasRunLinkage(workflowName: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM work_item_runs r
     JOIN workflow_runs w ON w.id = r.workflow_run_id
     WHERE w.workflow_name = ?
     LIMIT 1
  `).get(workflowName);
  return !!row;
}

/**
 * The output-markdown file path a job recorded for one work item, if any.
 * Jobs that write a markdown profile store its absolute path in the work item's
 * `detail.markdown` (places-llm-enrich, perfumes-build). Returns null when the
 * item has no recorded markdown artifact (or the detail isn't parseable).
 *
 * This is a DB read only — it does NOT touch the filesystem. The caller (the API
 * output endpoint) is responsible for path-safety + reading the file, confining
 * reads to the jobs' own data directories.
 */
export function workItemMarkdownPath(jobName: string, itemKey: string): string | null {
  const row = getWorkItem(jobName, itemKey);
  if (!row?.detail) return null;
  try {
    const d = JSON.parse(row.detail) as Record<string, unknown>;
    return typeof d.markdown === 'string' && d.markdown ? d.markdown : null;
  } catch {
    return null;
  }
}

/** One terminal-stage output item for the unified workflow output section (T205). */
export interface OutputItem {
  jobName: string;
  itemKey: string;
  /** Human-readable name from the item's detail.name, if recorded. */
  name: string | null;
  /** Whether a markdown artifact path is recorded in detail.markdown. */
  hasMarkdown: boolean;
  updatedAt: string;
}

/**
 * Return all success work_items for the given terminal-stage job names, with their
 * detail parsed into name + hasMarkdown fields. De-duped by (job_name, item_key)
 * by construction (the work_items ledger is keyed by that pair). Ordered newest first.
 * Used by GET /api/workflows/:name/output-items (T205).
 */
export function workflowTerminalItems(terminalJobNames: string[]): OutputItem[] {
  if (terminalJobNames.length === 0) return [];
  const ph = terminalJobNames.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT job_name, item_key, detail, updated_at FROM work_items WHERE job_name IN (${ph}) AND status = 'success' ORDER BY updated_at DESC`,
  ).all(...terminalJobNames) as { job_name: string; item_key: string; detail: string | null; updated_at: string }[];
  return rows.map((r) => {
    let name: string | null = null;
    let hasMarkdown = false;
    if (r.detail) {
      try {
        const d = JSON.parse(r.detail) as Record<string, unknown>;
        name = typeof d.name === 'string' && d.name ? d.name : null;
        hasMarkdown = typeof d.markdown === 'string' && !!d.markdown;
      } catch { /* ignore malformed detail */ }
    }
    return { jobName: r.job_name, itemKey: r.item_key, name, hasMarkdown, updatedAt: r.updated_at };
  });
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
 * "Ignore" a SURFACED (non-failed) item: park an arbitrary ledger key as
 * `ignored`, upserting the row if it doesn't exist yet. This EXTENDS the
 * stuck-only {@link ignoreWorkItem} to the audit-style workflows (movies/plex)
 * whose ledger tracks "have I notified this?" rather than work-done: an owner
 * ignores a still-VALID gap (a franchise film they own some-but-not-all of and
 * deliberately don't want) so it leaves BOTH future reports AND notifications and
 * never resurfaces — even though `isWorkItemDone` already treats `ignored` as
 * done, so a re-run won't re-notify it. MANUAL ONLY — nothing in the run/schedule
 * path calls this; it's invoked solely from a dashboard control. Unlike
 * {@link ignoreWorkItem} it does NOT require a `failed` row (a surfaced gap is
 * typically `success` after its one notification, or absent if never notified).
 * Returns the number of rows affected (always ≥1). */
export function ignoreSurfacedItem(jobName: string, itemKey: string): number {
  return db.prepare(`
    INSERT INTO work_items (job_name, item_key, status, attempts, root_key)
    VALUES (?, ?, 'ignored', 0, ?)
    ON CONFLICT(job_name, item_key) DO UPDATE SET
      status = 'ignored',
      updated_at = datetime('now')
  `).run(jobName, itemKey, itemKey).changes;
}

/**
 * Bulk-ignore multiple surfaced items in a single transaction. Calls
 * {@link ignoreSurfacedItem} semantics for each key: only the exact keys passed are
 * ignored — no collection-level rule is persisted. Returns the total rows affected.
 */
export function ignoreSurfacedItems(jobName: string, itemKeys: string[]): number {
  if (itemKeys.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO work_items (job_name, item_key, status, attempts, root_key)
    VALUES (?, ?, 'ignored', 0, ?)
    ON CONFLICT(job_name, item_key) DO UPDATE SET
      status = 'ignored',
      updated_at = datetime('now')
  `);
  const run = db.transaction((keys: string[]) => {
    let total = 0;
    for (const key of keys) total += stmt.run(jobName, key, key).changes;
    return total;
  });
  return run(itemKeys);
}

/** The set of `item_key`s a job has manually `ignored` — used to exclude ignored
 *  gaps from a fresh audit's report (the audit recomputes every run, so it must
 *  re-filter against this each time). */
export function ignoredItemKeys(jobName: string): Set<string> {
  const rows = db.prepare(
    "SELECT item_key FROM work_items WHERE job_name = ? AND status = 'ignored'",
  ).all(jobName) as { item_key: string }[];
  return new Set(rows.map((r) => r.item_key));
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

/**
 * Scope for bulk stuck-item operations: a single job, all jobs in a workflow,
 * or no scope (every stuck item across all jobs).
 */
export type BulkStuckScope =
  | { type: 'all' }
  | { type: 'job'; jobName: string }
  | { type: 'workflow'; jobNames: string[] };

/**
 * Bulk-unstick: delete all currently-'failed' ledger rows in scope (so they
 * retry fresh on the next run). Returns the number of rows removed. MANUAL ONLY.
 */
export function bulkUnstickItems(scope: BulkStuckScope, minAttempts = 4): number {
  if (scope.type === 'all') {
    return db.prepare("DELETE FROM work_items WHERE status = 'failed' AND attempts >= ?")
      .run(minAttempts).changes;
  }
  if (scope.type === 'job') {
    return db.prepare("DELETE FROM work_items WHERE job_name = ? AND status = 'failed' AND attempts >= ?")
      .run(scope.jobName, minAttempts).changes;
  }
  if (scope.jobNames.length === 0) return 0;
  const ph = scope.jobNames.map(() => '?').join(',');
  return db.prepare(`DELETE FROM work_items WHERE job_name IN (${ph}) AND status = 'failed' AND attempts >= ?`)
    .run(...scope.jobNames, minAttempts).changes;
}

/**
 * Bulk-ignore: permanently mark all currently-'failed' ledger rows in scope as
 * 'ignored', so they drop off the stuck list and are never reprocessed. Returns
 * the number of rows updated. MANUAL ONLY.
 */
export function bulkIgnoreItems(scope: BulkStuckScope, minAttempts = 4): number {
  if (scope.type === 'all') {
    return db.prepare("UPDATE work_items SET status = 'ignored', updated_at = datetime('now') WHERE status = 'failed' AND attempts >= ?")
      .run(minAttempts).changes;
  }
  if (scope.type === 'job') {
    return db.prepare("UPDATE work_items SET status = 'ignored', updated_at = datetime('now') WHERE job_name = ? AND status = 'failed' AND attempts >= ?")
      .run(scope.jobName, minAttempts).changes;
  }
  if (scope.jobNames.length === 0) return 0;
  const ph = scope.jobNames.map(() => '?').join(',');
  return db.prepare(`UPDATE work_items SET status = 'ignored', updated_at = datetime('now') WHERE job_name IN (${ph}) AND status = 'failed' AND attempts >= ?`)
    .run(...scope.jobNames, minAttempts).changes;
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

// On re-sync, code re-seeds the cron `schedule` ONLY while the user hasn't taken it
// over. Once `schedule_overridden = 1` (a dashboard edit, see updateWorkflowSchedule),
// the schedule is preserved from the existing row so code-sync never clobbers a user
// override — the same reconcile the user-owned `enabled` flag and the service limits
// get. description is code-owned and always refreshed.
const upsertWorkflowStmt = db.prepare(`
  INSERT INTO workflows (name, description, schedule, enabled, max_concurrency)
  VALUES (@name, @description, @schedule, 1, @maxConcurrency)
  ON CONFLICT(name) DO UPDATE SET
    description     = excluded.description,
    schedule        = CASE WHEN schedule_overridden = 1 THEN schedule ELSE excluded.schedule END,
    max_concurrency = CASE WHEN max_concurrency_overridden = 1 THEN max_concurrency ELSE excluded.max_concurrency END
`);

/** Upsert a workflow + REPLACE its membership/edges. `enabled`, an overridden
 *  `schedule`, and an overridden `max_concurrency` are preserved across the sync. */
export function syncWorkflow(def: WorkflowDefinition): void {
  const tx = db.transaction(() => {
    upsertWorkflowStmt.run({
      name: def.name,
      description: def.description ?? '',
      schedule: def.schedule ?? null,
      maxConcurrency: def.maxConcurrency ?? null,
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
  schedule_overridden: number;
  max_concurrency: number | null;
  max_concurrency_overridden: number;
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
    .prepare('UPDATE workflows SET schedule = ?, schedule_overridden = 1 WHERE name = ?')
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
    .prepare('UPDATE workflows SET max_concurrency = ?, max_concurrency_overridden = 1 WHERE name = ?')
    .run(n, name);
  if (info.changes === 0) return undefined;
  return getWorkflow(name);
}

export function getWorkflowJobs(name: string): { job_name: string; depends_on: string[] }[] {
  const rows = db.prepare('SELECT job_name, depends_on FROM workflow_jobs WHERE workflow_name = ?')
    .all(name) as { job_name: string; depends_on: string }[];
  return rows.map((r) => ({ job_name: r.job_name, depends_on: JSON.parse(r.depends_on) as string[] }));
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

// ════════════════════════ service consumers (T186) ════════════════════════

const _upsertServiceConsumer = db.prepare(`
  INSERT INTO service_consumers (service_name, job_name, last_used)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(service_name, job_name) DO UPDATE SET last_used = datetime('now')
`);

/** Record that a job called a service. Called from callService() in services.ts. */
export function recordServiceConsumer(serviceName: string, jobName: string): void {
  _upsertServiceConsumer.run(serviceName, jobName);
}

export interface ServiceConsumerRow {
  service_name: string;
  job_name: string;
  workflow_name: string | null;
  last_used: string;
}

/**
 * List all jobs (+ their workflow) that have ever called a service, ordered by
 * workflow then job name. A job not yet in workflow_jobs shows workflow_name = null.
 */
export function listServiceConsumers(serviceName: string): ServiceConsumerRow[] {
  return db.prepare(`
    SELECT sc.service_name, sc.job_name, wj.workflow_name, sc.last_used
    FROM service_consumers sc
    LEFT JOIN workflow_jobs wj ON wj.job_name = sc.job_name
    WHERE sc.service_name = ?
    ORDER BY wj.workflow_name, sc.job_name
  `).all(serviceName) as ServiceConsumerRow[];
}

// ════════════════════ workflow output reset (T203) ════════════════════

export interface WorkflowResetResult {
  jobNames: string[];
  itemsDeleted: number;
  runsDeleted: number;
  wfRunsDeleted: number;
}

/**
 * Clear ALL output data for a workflow — scoped to its member jobs.
 * Deletes in a single transaction:
 *   • `work_item_runs` attribution rows for the member jobs
 *   • `work_items` ledger rows for the member jobs
 *   • `run_logs` for those jobs' runs
 *   • `runs` for those jobs
 *   • `workflow_run_logs` for those workflow runs
 *   • `workflow_runs` for the named workflow
 *
 * Does NOT touch: `data/raw/**` files, definition tables (jobs/workflows/services),
 * user settings (enabled/schedule/concurrency overrides, service limits), or
 * `service_usage` (a cross-workflow spend meter).
 *
 * Filesystem cleanup (data/out/**) is performed by the API layer after calling this.
 * MANUAL ONLY — never invoked from the run/schedule path.
 */
export function resetWorkflowOutput(workflowName: string): WorkflowResetResult {
  const members = getWorkflowJobs(workflowName);
  const jobNames = members.map((m) => m.job_name);
  if (jobNames.length === 0) {
    return { jobNames: [], itemsDeleted: 0, runsDeleted: 0, wfRunsDeleted: 0 };
  }
  const ph = jobNames.map(() => '?').join(',');

  const tx = db.transaction(() => {
    // work_item_runs: attribution rows for member jobs
    db.prepare(`DELETE FROM work_item_runs WHERE job_name IN (${ph})`).run(...jobNames);
    // work_items: ledger rows for member jobs
    const itemsDeleted = db.prepare(`DELETE FROM work_items WHERE job_name IN (${ph})`).run(...jobNames).changes;
    // run_logs: cascade-delete before runs (subquery avoids large IN lists)
    db.prepare(`DELETE FROM run_logs WHERE run_id IN (SELECT id FROM runs WHERE job_name IN (${ph}))`).run(...jobNames);
    // runs: member job runs
    const runsDeleted = db.prepare(`DELETE FROM runs WHERE job_name IN (${ph})`).run(...jobNames).changes;
    // workflow_run_logs: cascade-delete before workflow_runs
    db.prepare('DELETE FROM workflow_run_logs WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE workflow_name = ?)').run(workflowName);
    // workflow_runs: all runs of this workflow
    const wfRunsDeleted = db.prepare('DELETE FROM workflow_runs WHERE workflow_name = ?').run(workflowName).changes;
    return { itemsDeleted, runsDeleted, wfRunsDeleted };
  });

  const result = tx();
  return { jobNames, ...result };
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

// ─────────────────── Canned (predefined) read-only queries ───────────────────
// A curated set of useful cross-table views surfaced on the Database page. These
// are NOT a free-form SQL editor: the client only ever picks a query by `id`, and
// each query's SQL is a FIXED, hand-written SELECT defined here — no client text
// ever reaches a query. Every query is read-only (SELECT-only) by construction.

interface CannedQueryDef {
  id: string;
  title: string;
  description: string;
  sql: string;
}

/** The fixed catalogue. Order here is the order shown on the dashboard. */
const CANNED_QUERIES: CannedQueryDef[] = [
  {
    id: 'recent-failed-runs',
    title: 'Recent failed runs',
    description: 'Last 50 job runs that failed, timed out, or were cancelled (most recent first).',
    sql: `SELECT id, job_name, status, trigger, attempt, started_at, finished_at, duration_ms, error
          FROM runs
          WHERE status IN ('failed', 'timeout', 'cancelled')
          ORDER BY COALESCE(started_at, '') DESC, rowid DESC
          LIMIT 50`,
  },
  {
    id: 'stuck-ignored-items',
    title: 'Stuck & ignored items by job',
    description: 'Per job, how many work items are failed (stuck) or manually ignored, with the most recent update.',
    sql: `SELECT job_name, status, COUNT(*) AS items, MAX(updated_at) AS last_update
          FROM work_items
          WHERE status IN ('failed', 'ignored')
          GROUP BY job_name, status
          ORDER BY job_name, status`,
  },
  {
    id: 'work-item-status',
    title: 'Work items by status per job',
    description: 'Full breakdown of the per-item ledger: how many items in each status, per job.',
    sql: `SELECT job_name, status, COUNT(*) AS items, MAX(updated_at) AS last_update
          FROM work_items
          GROUP BY job_name, status
          ORDER BY job_name, status`,
  },
  {
    id: 'service-spend',
    title: 'Service usage vs caps (this month)',
    description: 'Each service: calls today and this month against its daily/monthly caps (UTC windows).',
    sql: `SELECT s.name,
                 s.paid,
                 s.daily_cap,
                 s.monthly_cap,
                 (SELECT COUNT(*) FROM service_usage u
                    WHERE u.service = s.name AND u.ts >= datetime('now', 'start of day')) AS used_today,
                 (SELECT COUNT(*) FROM service_usage u
                    WHERE u.service = s.name AND u.ts >= datetime('now', 'start of month')) AS used_month
          FROM services s
          ORDER BY s.name`,
  },
  {
    id: 'workflow-run-outcomes',
    title: 'Recent workflow-run outcomes',
    description: 'Last 50 workflow runs with their status, trigger, and duration (most recent first).',
    sql: `SELECT id, workflow_name, status, trigger, progress, started_at, finished_at, duration_ms
          FROM workflow_runs
          ORDER BY COALESCE(started_at, '') DESC, rowid DESC
          LIMIT 50`,
  },
];

export interface CannedQueryMeta {
  id: string;
  title: string;
  description: string;
}

export interface CannedQueryResult extends CannedQueryMeta {
  columns: string[];
  rows: Record<string, unknown>[];
}

/** The catalogue of available canned queries (metadata only — no rows). */
export function listCannedQueries(): CannedQueryMeta[] {
  return CANNED_QUERIES.map(({ id, title, description }) => ({ id, title, description }));
}

/**
 * Run one canned query by `id`. Returns null for an unknown id — the only input
 * is the id, matched against the fixed catalogue, so no client text can reach SQL.
 * Columns are derived from the first row (falling back to [] for an empty result).
 */
export function runCannedQuery(id: string): CannedQueryResult | null {
  const def = CANNED_QUERIES.find((q) => q.id === id);
  if (!def) return null;
  const rows = db.prepare(def.sql).all() as Record<string, unknown>[];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { id: def.id, title: def.title, description: def.description, columns, rows };
}
