import { db } from '../index.js';
import { normalizeDetailPaths } from './lib.js';

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
 *
 * `skipped` means soft-stopped (e.g. quota exhausted) — NOT done; the item
 * will be retried on the next run when the quota resets. It is never counted
 * as stuck (the stuck query only matches `failed` rows).
 */
export function isWorkItemDone(jobName: string, itemKey: string, maxAttempts: number): boolean {
  const row = getWorkItem(jobName, itemKey);
  if (!row) return false;
  if (row.status === 'success' || row.status === 'ignored') return true;
  if (row.status === 'skipped') return false; // retry when quota resets
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
  const normalizedDetail = normalizeDetailPaths(opts.detail);
  const detail = normalizedDetail === undefined ? null : JSON.stringify(normalizedDetail);
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
 * yet done. For root-selection purposes, `skipped` (quota soft-stop) is treated as
 * handled (NOT outstanding): a root whose only non-done items are `skipped` falls
 * through to `rootHasTerminalBlocker` and is treated as done for limited-run
 * selection. Unlimited scheduled runs still retry `skipped` items (isWorkItemDone
 * remains false for `skipped`). T258.
 */
function rootHasOutstandingWork(jobNames: string[], rootKey: string, minAttempts: number): boolean {
  if (jobNames.length === 0) return false;
  const ph = jobNames.map(() => '?').join(',');
  const row = db.prepare(`
    SELECT 1 FROM work_items
     WHERE job_name IN (${ph}) AND root_key = ?
       AND NOT (status IN ('success','ignored','skipped') OR (status = 'failed' AND attempts >= ?))
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
 * Does this root carry a "gave up" marker anywhere — an `ignored` row, a quota
 * soft-stop `skipped` row, OR a retry-exhausted (`failed` past the budget) row at
 * any stage (T163, T258)? Such a root is handled/unprogressable BELOW the terminal
 * stage (it can't advance further in a limited run), so once it has no outstanding
 * retryable work (step 1) and hasn't reached terminal (step 2) it is treated as
 * DONE rather than perpetually pending. The `skipped` case: a quota-soft-stopped
 * root is treated as done for limited-run selection — unlimited scheduled runs still
 * retry `skipped` items via isWorkItemDone (which returns false for `skipped`).
 */
function rootHasTerminalBlocker(jobNames: string[], rootKey: string, minAttempts: number): boolean {
  if (jobNames.length === 0) return false;
  const ph = jobNames.map(() => '?').join(',');
  const row = db.prepare(`
    SELECT 1 FROM work_items
     WHERE job_name IN (${ph}) AND root_key = ?
       AND (status IN ('ignored','skipped') OR (status = 'failed' AND attempts >= ?))
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

type LedgerRow = { job_name: string; item_key: string; status: string; detail: string | null; root_key: string | null };

/** A single work-item ledger row, as shown in a decoupled inputs/outputs list. */
export interface StageIoItem {
  jobName: string;
  itemKey: string;
  status: string;
  detail: unknown;
}

export interface StageIoLists {
  inputs: StageIoItem[];
  outputs: StageIoItem[];
}

function toStageIoItem(r: LedgerRow): StageIoItem {
  return {
    jobName: r.job_name,
    itemKey: r.item_key,
    status: r.status,
    detail: r.detail != null ? (JSON.parse(r.detail) as unknown) : null,
  };
}

/**
 * Decoupled inputs/outputs for a set of stages of ONE workflow run (added for
 * `stock-digest` — see its workflow-run page, now the panel every workflow's run
 * page uses). Rather than pairing each input to "the first matching output by
 * root_key" (which silently collapses genuine fan-out/fan-in to one row and looks
 * confusing for a many-to-one aggregation stage), this returns TWO independent,
 * un-paired lists:
 *  - `outputs`: every `work_items` row any of `outputJobNames` recorded THIS run
 *    (via the `work_item_runs` linkage).
 *  - `inputs`: every `work_items` row any of `inputJobNames` recorded THIS run.
 * Neither list tries to line up with the other — a genuine 9-ticker output
 * list and a genuine 1-item input list are both shown in full, honestly.
 * `root_key` grouping (root_key/parent_key lineage, T094) still exists on the
 * underlying rows for OTHER purposes (limiting, idempotency) — this view just
 * doesn't use it to force a join. Both parameters accept multiple job names so a
 * whole parallel DAG wave (or a workflow's root/terminal wave) can be represented
 * on either side, not just a single stage (T383) — the single-job case (each array
 * with exactly one entry) behaves identically to before.
 *
 * **Self-recorded `input-sample` rows (T615).** A recommender branch job records,
 * under its OWN job name, both its per-suggestion output rows AND (separately)
 * `detail.kind === 'input-sample'` rows capturing the EXACT owned items its
 * `build()` put into its Claude prompt — its predecessor's ledger rows (the full
 * snapshot) are NOT that branch's true input, since the branch only used a
 * lens-filtered subset of them. So for every job in `outputJobNames`, any row it
 * recorded with `detail.kind === 'input-sample'` is routed into `inputs` instead
 * of `outputs` — the same "alternate ledger source for a decoupled stage" idea
 * `outputJob` already applies at the workflow level, generalized here to a
 * single job's own two disjoint row kinds.
 */
export function stageIoLists(
  outputJobNames: string[],
  inputJobNames: string[],
  workflowRunId: string,
): StageIoLists {
  const queryJobRows = (jobNames: string[]): LedgerRow[] => {
    if (jobNames.length === 0) return [];
    const ph = jobNames.map(() => '?').join(',');
    return db.prepare(`
      SELECT wi.job_name, wi.item_key, wi.status, wi.detail, wi.root_key
      FROM work_items wi
      JOIN work_item_runs wr
        ON wr.job_name = wi.job_name AND wr.item_key = wi.item_key AND wr.workflow_run_id = ?
      WHERE wi.job_name IN (${ph})
      ORDER BY wi.job_name, wi.item_key
    `).all(workflowRunId, ...jobNames) as LedgerRow[];
  };

  const isInputSample = (r: LedgerRow): boolean => {
    if (!r.detail) return false;
    try {
      return (JSON.parse(r.detail) as { kind?: unknown } | null)?.kind === 'input-sample';
    } catch {
      return false;
    }
  };

  const outputRows = queryJobRows(outputJobNames);
  const outputs = outputRows.filter((r) => !isInputSample(r));
  const selfInputSamples = outputRows.filter(isInputSample);
  const inputs = [...queryJobRows(inputJobNames), ...selfInputSamples];

  return { inputs: inputs.map(toStageIoItem), outputs: outputs.map(toStageIoItem) };
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
 * An optional `detail` (e.g. `{ title, year }`) is stored on a FRESH row so a
 * pre-notify ignore (one that never made it into a history file) still carries a
 * recoverable title for later exclude-list building (T404). When omitted, any
 * existing non-null `detail` on the row is PRESERVED, not clobbered to `NULL` —
 * an already-`success` row (e.g. the T145/T209 ignore-an-already-recommended-item
 * path) keeps its `name`/`markdown` detail when ignored.
 * Returns the number of rows affected (always ≥1). */
export function ignoreSurfacedItem(jobName: string, itemKey: string, detail?: unknown): number {
  const detailJson = detail === undefined ? null : JSON.stringify(detail);
  return db.prepare(`
    INSERT INTO work_items (job_name, item_key, status, attempts, root_key, detail)
    VALUES (?, ?, 'ignored', 0, ?, ?)
    ON CONFLICT(job_name, item_key) DO UPDATE SET
      status = 'ignored',
      updated_at = datetime('now'),
      detail = COALESCE(excluded.detail, work_items.detail)
  `).run(jobName, itemKey, itemKey, detailJson).changes;
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

/**
 * "Un-ignore" a surfaced item: delete its `ignored` ledger row so it's treated as
 * brand-new on the next run — the OPPOSITE of {@link ignoreSurfacedItem}, mirroring
 * {@link unstickWorkItem}'s delete-and-refresh pattern rather than resetting to some
 * other status. Because the audit-style workflows' ledger means "have I already
 * notified this?" (T144), deleting the row means the item CAN be re-notified/reappear
 * in a future digest — this is the deliberate, documented behavior of un-ignoring.
 * MANUAL ONLY. Returns the number of rows removed (0 if it wasn't ignored).
 */
export function unignoreSurfacedItem(jobName: string, itemKey: string): number {
  return db.prepare("DELETE FROM work_items WHERE job_name = ? AND item_key = ? AND status = 'ignored'")
    .run(jobName, itemKey).changes;
}

/**
 * Bulk "un-ignore" multiple surfaced items in a single transaction. Calls
 * {@link unignoreSurfacedItem} semantics for each key: deletes each key's `ignored`
 * ledger row so it's treated as brand-new on the next run. A key that isn't
 * currently ignored is a no-op for that key. Returns the total rows removed.
 */
export function unignoreSurfacedItems(jobName: string, itemKeys: string[]): number {
  if (itemKeys.length === 0) return 0;
  const stmt = db.prepare("DELETE FROM work_items WHERE job_name = ? AND item_key = ? AND status = 'ignored'");
  const run = db.transaction((keys: string[]) => {
    let total = 0;
    for (const key of keys) total += stmt.run(jobName, key).changes;
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

/** A single job's `ignored` ledger rows with their parsed `detail`, scoped to one
 *  job name — used to recover a title/year for excluding an ignored suggestion
 *  from future recommender prompts (T404), distinct from {@link ignoredItemKeys}
 *  which only returns the bare keys. */
export function ignoredWorkItemDetails(jobName: string): { itemKey: string; detail: unknown }[] {
  const rows = db.prepare(
    "SELECT item_key, detail FROM work_items WHERE job_name = ? AND status = 'ignored'",
  ).all(jobName) as { item_key: string; detail: string | null }[];
  return rows.map((r) => ({ itemKey: r.item_key, detail: r.detail ? JSON.parse(r.detail) : null }));
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
