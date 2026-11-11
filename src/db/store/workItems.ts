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
 * All `success` rows for one job, full row including `detail` + `updated_at`.
 * Ordered by `item_key` for a deterministic iteration order. Used by consumers
 * that need to enumerate another job's completed output with its recorded
 * artifact paths (e.g. vault-sync) — `workflowTerminalItems` deliberately
 * returns only display booleans, not the raw detail.
 */
export function listSuccessWorkItems(jobName: string): WorkItemRow[] {
  return db.prepare("SELECT * FROM work_items WHERE job_name = ? AND status = 'success' ORDER BY item_key")
    .all(jobName) as WorkItemRow[];
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

/** The largest per-run detail snapshot kept verbatim; bigger ones keep only their display keys. */
const SNAPSHOT_DETAIL_MAX = 16 * 1024;

/** The detail to freeze on the per-run snapshot row (capped: see SNAPSHOT_DETAIL_MAX). */
function snapshotDetail(detailJson: string | null, normalized: unknown): string | null {
  if (detailJson === null || detailJson.length <= SNAPSHOT_DETAIL_MAX) return detailJson;
  const d = (normalized && typeof normalized === 'object' && !Array.isArray(normalized) ? normalized : {}) as Record<string, unknown>;
  const kept: Record<string, unknown> = { _truncated: true };
  for (const k of ['name', 'title', 'markdown', 'path', 'format', 'error']) if (k in d) kept[k] = d[k];
  return JSON.stringify(kept);
}

export interface MarkWorkItemOptions {
  attempts?: number;
  detail?: unknown;
  rootKey?: string;
  parentKey?: string;
  parentJob?: string;
  /**
   * The upstream ledger item this item was made FROM: the job that recorded it
   * and its key there (defaults to this item's own key). Recorded on the per-run
   * snapshot so the run page can show, as this stage's inputs, exactly the
   * upstream items it worked on this run, whenever those were themselves written.
   */
  from?: { job: string; key?: string };
  /** Display title for the run page. Defaults to `detail.name` when that is a string. */
  title?: string;
  /**
   * The workflow run advancing this item (T139). Defaults to the child's
   * `LOCALJOBS_WORKFLOW_RUN_ID` env (set by the executor for every workflow
   * member), so existing job call sites need no change. When present, a
   * `work_item_runs` row is recorded so the run page can show what THIS run did;
   * `null` (a standalone run) records nothing. Pass explicitly only for testing.
   */
  workflowRunId?: string | null;
  /** The member run (stage attempt) writing this. Defaults to `LOCALJOBS_RUN_ID`. Tests only. */
  runId?: string | null;
}

/**
 * Record (upsert) the outcome of processing a work item. `detail` is JSON-serialized.
 * Lineage opts (T094) are all optional + back-compatible: with none given the item
 * is its own root (`root_key = item_key`). Pass `rootKey` (or `parentKey`/`parentJob`
 * to inherit) only on a stage that changes keys or fans out, so a run-limit can
 * bound originating inputs and still run all their descendants.
 *
 * Two rows are written, in one transaction:
 *  - `work_items`: the CUMULATIVE ledger, one row per (job, item), overwritten in
 *    place. It answers "is this item done?".
 *  - `work_item_runs`: a per-run SNAPSHOT, one row per (workflow run, job, item),
 *    freezing what this run recorded (status, attempts, detail), which stage
 *    attempt wrote it, what it was made from, and whether it `changed` anything
 *    (a brand-new item, or a different status / attempts / detail) as opposed to
 *    re-recording an identical row. It answers "what did THIS run do?", and stays
 *    true after later runs overwrite the ledger row. The detail is stored only
 *    when the row changed, so a stage that re-records a large unchanged catalogue
 *    every run costs almost nothing.
 */
export function markWorkItem(
  jobName: string,
  itemKey: string,
  status: WorkStatus,
  opts: MarkWorkItemOptions = {},
): void {
  db.transaction(() => { writeWorkItem(jobName, itemKey, status, opts); }).immediate();
}

/** What one ledger write did, for callers that tally (`markWorkItems`). */
export type WorkItemWrite = 'added' | 'changed' | 'unchanged';

/**
 * Record MANY items for one job in batched transactions (one write lock per
 * `chunk` items, not one per item). For a stage that re-records a whole snapshot
 * every run (tens of thousands of rows), this is the difference between tens of
 * thousands of separate commits and a few dozen. Same semantics per item as
 * `markWorkItem`. Returns how many rows were new, changed, or identical.
 */
export function markWorkItems(
  jobName: string,
  entries: Array<{ key: string; status: WorkStatus } & MarkWorkItemOptions>,
  chunk = 500,
): { added: number; changed: number; unchanged: number } {
  const tally = { added: 0, changed: 0, unchanged: 0 };
  const write = db.transaction((batch: typeof entries) => {
    for (const { key, status, ...opts } of batch) tally[writeWorkItem(jobName, key, status, opts)]++;
  });
  for (let i = 0; i < entries.length; i += chunk) write.immediate(entries.slice(i, i + chunk));
  return tally;
}

/** The body of a ledger write. MUST be called inside an IMMEDIATE transaction. */
function writeWorkItem(
  jobName: string,
  itemKey: string,
  status: WorkStatus,
  opts: MarkWorkItemOptions,
): WorkItemWrite {
  const normalizedDetail = normalizeDetailPaths(opts.detail);
  const detail = normalizedDetail === undefined ? null : JSON.stringify(normalizedDetail);
  const rootKey = resolveRootKey(jobName, itemKey, opts);
  const parentKey = opts.parentKey ?? null;
  const attempts = opts.attempts ?? 1;
  const fromEnv = opts.workflowRunId === undefined;
  const workflowRunId = fromEnv ? (process.env.LOCALJOBS_WORKFLOW_RUN_ID || null) : opts.workflowRunId;
  const runId = opts.runId !== undefined ? opts.runId : fromEnv ? (process.env.LOCALJOBS_RUN_ID || null) : null;
  const cycle = fromEnv && process.env.LOCALJOBS_RUN_CYCLE ? Number(process.env.LOCALJOBS_RUN_CYCLE) || null : null;

  // The ledger row and its per-run row are written in ONE transaction: a process
  // killed between the two used to leave an item the ledger said was done but no
  // run was credited with, which the run page and the noop/stall checks then read
  // as "this run did nothing".
  //
  // IMMEDIATE, not the default deferred (see the callers): this reads the item's
  // prior state before writing. A deferred transaction starts as a reader, and if
  // any other process commits before its first write, the upgrade to a writer
  // fails at once with "database is locked" (a stale snapshot cannot be waited
  // out, so the busy timeout does not apply). Several job processes and the daemon
  // write this file at the same time, so that is a certainty, not an edge case.
  // Taking the write lock up front makes the busy timeout apply. See
  // concurrent-writers.test.ts.
  {
    const prior = db.prepare('SELECT status, attempts, detail FROM work_items WHERE job_name = ? AND item_key = ?')
      .get(jobName, itemKey) as { status: string; attempts: number; detail: string | null } | undefined;
    const changed = !prior || prior.status !== status || prior.attempts !== attempts || prior.detail !== detail;
    const outcome: WorkItemWrite = !prior ? 'added' : changed ? 'changed' : 'unchanged';

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
    `).run({ job: jobName, key: itemKey, status, attempts, detail, root: rootKey, parent: parentKey });

    if (!workflowRunId) return outcome;
    const d = normalizedDetail as Record<string, unknown> | null | undefined;
    const title = opts.title ?? (d && typeof d === 'object' && typeof d.name === 'string' ? d.name : null);
    const inputJob = opts.from?.job ?? (opts.parentKey ? (opts.parentJob ?? jobName) : null);
    const inputKey = opts.from ? (opts.from.key ?? itemKey) : (opts.parentKey ?? null);
    // Within one run a later identical re-mark must not erase an earlier real
    // change: `changed` only ever goes up, and the frozen detail is replaced only
    // by a mark that itself changed something.
    db.prepare(`
      INSERT INTO work_item_runs (workflow_run_id, job_name, item_key, root_key, run_id, cycle, status, attempts,
                                  detail, title, input_job, input_key, at_ms, changed)
      VALUES (@wf, @job, @key, @root, @run, @cycle, @status, @attempts, @detail, @title, @inputJob, @inputKey, @at, @changed)
      ON CONFLICT(workflow_run_id, job_name, item_key) DO UPDATE SET
        root_key = excluded.root_key,
        at = datetime('now'),
        run_id = COALESCE(excluded.run_id, run_id),
        cycle = COALESCE(excluded.cycle, cycle),
        status = excluded.status,
        attempts = excluded.attempts,
        detail = CASE WHEN excluded.changed = 1 THEN excluded.detail ELSE detail END,
        title = COALESCE(excluded.title, title),
        input_job = COALESCE(excluded.input_job, input_job),
        input_key = COALESCE(excluded.input_key, input_key),
        at_ms = excluded.at_ms,
        changed = MAX(COALESCE(changed, 0), excluded.changed)
    `).run({
      wf: workflowRunId,
      job: jobName,
      key: itemKey,
      root: rootKey,
      run: runId,
      cycle,
      status,
      attempts,
      detail: changed ? snapshotDetail(detail, normalizedDetail) : null,
      title,
      inputJob,
      inputKey,
      at: Date.now(),
      changed: changed ? 1 : 0,
    });
    return outcome;
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
 *  3b. else if a stage that declares `settles` recorded a result for it meaning
 *     "nothing further to do" (evaluated, no change needed) → done. Without this
 *     a workflow whose final stage only records the items it changed could never
 *     finish such an item, and every limited run picked it and did nothing;
 *  4. else it has unattempted downstream work (e.g. a resolved-but-not-yet-enriched
 *     place: entry succeeded, a later stage has NO row at all) → pending.
 * Step 4 is the bug this fixes: previously a root whose later stages simply hadn't
 * been attempted (no row) looked "fully done" and was never selected.
 */
/** Per stage: does this recorded result mean the item needs nothing further? (`JobDefinition.settles`) */
export type SettlesByJob = ReadonlyMap<string, (detail: Record<string, unknown>) => boolean>;

/**
 * Has some stage recorded, for this root, a result that says nothing further will
 * be done for it (rule 3b of {@link isRootPending})? Looks only at the successful
 * rows of stages that declare `settles`. A row whose detail does not parse, or a
 * `settles` that throws, counts as "not settled": the root stays selectable, which
 * costs a wasted pick but never hides work.
 */
function rootIsSettled(settles: SettlesByJob, rootKey: string): boolean {
  if (settles.size === 0) return false;
  const jobNames = [...settles.keys()];
  const ph = jobNames.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT job_name, detail FROM work_items
     WHERE job_name IN (${ph}) AND root_key = ? AND status = 'success'
  `).all(...jobNames, rootKey) as { job_name: string; detail: string | null }[];
  for (const row of rows) {
    try {
      const detail = row.detail ? (JSON.parse(row.detail) as unknown) : null;
      if (detail && typeof detail === 'object' && settles.get(row.job_name)!(detail as Record<string, unknown>)) return true;
    } catch { /* not settled */ }
  }
  return false;
}

export function isRootPending(
  members: string[],
  terminalJobs: string[],
  rootKey: string,
  minAttempts: number,
  settles: SettlesByJob = new Map(),
): boolean {
  if (rootHasOutstandingWork(members, rootKey, minAttempts)) return true;     // (1)
  if (rootReachedTerminal(terminalJobs, rootKey, minAttempts)) return false;  // (2)
  if (rootHasTerminalBlocker(members, rootKey, minAttempts)) return false;    // (3)
  if (rootIsSettled(settles, rootKey)) return false;                          // (3b)
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
 * `settles` carries each stage's `settles` function, for stages that can decide an
 * item is finished without the final stage ever recording it.
 */
export function selectPendingRoots(
  members: string[],
  terminalJobs: string[],
  candidateRootsInOrder: string[],
  n: number,
  minAttempts: number,
  settles: SettlesByJob = new Map(),
): string[] {
  if (n <= 0) return [];
  const selected: string[] = [];
  for (const root of candidateRootsInOrder) {
    if (isRootPending(members, terminalJobs, root, minAttempts, settles)) selected.push(root);
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
  /** Total row counts per side, INDEPENDENT of any paging applied — the client's "X of Y". */
  inputTotal: number;
  outputTotal: number;
}

/** Optional paging for stageIoLists — each side gets its own offset, one shared page size. */
export interface StageIoPage {
  limit: number;
  inputsOffset: number;
  outputsOffset: number;
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
 * **`input-sample` rows (T615), kept for old runs only.** Before ports, a
 * recommender branch recorded, under its own job name, both its suggestions and
 * (with `detail.kind === 'input-sample'`) the exact owned titles it had put into
 * its prompt. Such a row is routed into `inputs` here, not `outputs`. No stage
 * writes these any more (a ports stage reports what it used through
 * `ctx.input(p).used(items)`), but runs recorded back then still hold them, and
 * this function only serves those runs now (`legacyStageIo` in
 * `src/engine/reporting.ts`).
 */
export function stageIoLists(
  outputJobNames: string[],
  inputJobNames: string[],
  workflowRunId: string,
  page?: StageIoPage,
): StageIoLists {
  // The input-sample routing (T615) is applied IN SQL — with paging, filtering
  // rows out in JS after a LIMIT/OFFSET would silently break the offset math
  // (a page of 100 could shrink to 97 and rows between pages would be skipped).
  // NB the COALESCE is load-bearing: json_extract yields SQL NULL for a detail
  // with no `kind` key, and `NOT (... AND NULL)` is NULL — which silently
  // excludes every normal row. COALESCE makes the predicate total (true/false).
  const SAMPLE_PRED = `(wi.detail IS NOT NULL AND json_valid(wi.detail) AND COALESCE(json_extract(wi.detail, '$.kind'), '') = 'input-sample')`;

  const querySide = (where: string, whereArgs: string[], offset: number): { rows: LedgerRow[]; total: number } => {
    if (!where) return { rows: [], total: 0 };
    const base = `
      FROM work_items wi
      JOIN work_item_runs wr
        ON wr.job_name = wi.job_name AND wr.item_key = wi.item_key AND wr.workflow_run_id = ?
      WHERE ${where}
    `;
    const total = (db.prepare(`SELECT COUNT(*) AS n ${base}`).get(workflowRunId, ...whereArgs) as { n: number }).n;
    const paging = page ? ` LIMIT ${Math.max(1, Math.floor(page.limit))} OFFSET ${Math.max(0, Math.floor(offset))}` : '';
    const rows = db.prepare(
      // Prefer what THIS run recorded (the per-run snapshot) over the ledger's
      // current state, so an old run's page is not rewritten by later runs. The
      // snapshot holds a detail only when the run changed the item; rows from
      // before the snapshot existed fall back to the ledger.
      `SELECT wi.job_name, wi.item_key, COALESCE(wr.status, wi.status) AS status,
              CASE WHEN wr.changed = 1 THEN wr.detail ELSE wi.detail END AS detail, wi.root_key
       ${base} ORDER BY wi.job_name, wi.item_key${paging}`,
    ).all(workflowRunId, ...whereArgs) as LedgerRow[];
    return { rows, total };
  };

  const inList = (names: string[]) => names.map(() => '?').join(',');

  // Outputs: the output jobs' own rows, minus their self-recorded input samples.
  const outputSide = outputJobNames.length === 0
    ? { rows: [] as LedgerRow[], total: 0 }
    : querySide(`wi.job_name IN (${inList(outputJobNames)}) AND NOT ${SAMPLE_PRED}`, outputJobNames, page?.outputsOffset ?? 0);

  // Inputs: the predecessor jobs' rows, plus the output jobs' input-sample rows.
  const inputClauses: string[] = [];
  const inputArgs: string[] = [];
  if (inputJobNames.length > 0) {
    inputClauses.push(`wi.job_name IN (${inList(inputJobNames)})`);
    inputArgs.push(...inputJobNames);
  }
  if (outputJobNames.length > 0) {
    inputClauses.push(`(wi.job_name IN (${inList(outputJobNames)}) AND ${SAMPLE_PRED})`);
    inputArgs.push(...outputJobNames);
  }
  const inputSide = inputClauses.length === 0
    ? { rows: [] as LedgerRow[], total: 0 }
    : querySide(inputClauses.join(' OR '), inputArgs, page?.inputsOffset ?? 0);

  return {
    inputs: inputSide.rows.map(toStageIoItem),
    outputs: outputSide.rows.map(toStageIoItem),
    inputTotal: inputSide.total,
    outputTotal: outputSide.total,
  };
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
  /**
   * Whether the item has ANY viewable output artifact recorded (T616) — either
   * a legacy `detail.markdown` path, or the newer T262 output form
   * (`detail.format` + `detail.path`). Format-agnostic signal the dashboard's
   * Output section uses to decide whether to show a "View" button; the backend
   * output endpoint (`resolveOutputForm`) already serves both forms, so this
   * field just plumbs that viewability through to the client.
   */
  viewable: boolean;
  updatedAt: string;
}

/**
 * Return all success work_items for the given terminal-stage job names, with their
 * detail parsed into name + hasMarkdown/viewable fields. De-duped by (job_name, item_key)
 * by construction (the work_items ledger is keyed by that pair). Ordered newest first.
 * Used by GET /api/workflows/:name/output-items (T205).
 */
export function workflowTerminalItems(
  terminalJobNames: string[],
  page?: { limit: number; offset: number },
): OutputItem[] {
  if (terminalJobNames.length === 0) return [];
  const ph = terminalJobNames.map(() => '?').join(',');
  // (job_name, item_key) is the ledger's UNIQUE key but updated_at ties are common
  // (a bulk stage marks many rows in one second) — the rowid tiebreaker keeps
  // paging deterministic (the T112 latest-run ordering rule, applied here).
  const paging = page ? ` LIMIT ${Math.max(1, Math.floor(page.limit))} OFFSET ${Math.max(0, Math.floor(page.offset))}` : '';
  const rows = db.prepare(
    `SELECT job_name, item_key, detail, updated_at FROM work_items WHERE job_name IN (${ph}) AND status = 'success' ORDER BY updated_at DESC, rowid DESC${paging}`,
  ).all(...terminalJobNames) as { job_name: string; item_key: string; detail: string | null; updated_at: string }[];
  return rows.map((r) => {
    let name: string | null = null;
    let hasMarkdown = false;
    let viewable = false;
    if (r.detail) {
      try {
        const d = JSON.parse(r.detail) as Record<string, unknown>;
        name = typeof d.name === 'string' && d.name ? d.name : null;
        hasMarkdown = typeof d.markdown === 'string' && !!d.markdown;
        const hasFormatPath = typeof d.format === 'string' && !!d.format
          && typeof d.path === 'string' && !!d.path;
        viewable = hasMarkdown || hasFormatPath;
      } catch { /* ignore malformed detail */ }
    }
    return { jobName: r.job_name, itemKey: r.item_key, name, hasMarkdown, viewable, updatedAt: r.updated_at };
  });
}

/**
 * Delete a SNAPSHOT job's ledger rows whose keys were NOT seen this run —
 * for stages whose ledger is re-marked fresh every run (plex-rename's
 * discover/plan/verify), where a key that stops being emitted is a GHOST
 * (found live: pre-fix ungrouped double-episode rows lingered forever and
 * re-noised every apply run as "source no longer present" soft-skips).
 * This is DISTINCT from the manual `pruneOrphanedWorkItems` flow and MUST
 * NEVER be pointed at a once-ever ledger (apply/confirm) — deleting those
 * rows would re-arm already-done mutations. Callers must also skip it on
 * LIMITED runs, where only the selected roots get re-marked.
 */
export function pruneSnapshotRows(jobName: string, seenKeys: string[]): number {
  const res = db.prepare(
    `DELETE FROM work_items WHERE job_name = ? AND item_key NOT IN (SELECT value FROM json_each(?))`,
  ).run(jobName, JSON.stringify(seenKeys));
  return res.changes;
}

/** Total success rows for the given terminal-stage job names — the Output section's "X of Y". */
export function workflowTerminalItemsCount(terminalJobNames: string[]): number {
  if (terminalJobNames.length === 0) return 0;
  const ph = terminalJobNames.map(() => '?').join(',');
  return (db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE job_name IN (${ph}) AND status = 'success'`)
    .get(...terminalJobNames) as { n: number }).n;
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

/**
 * How many items have given up (failed, out of retries) across every member job
 * of one workflow. Used by the aggregate run notification so a push can carry the
 * stuck heads-up the notifier has always claimed to send, without the caller
 * having to enumerate member jobs itself.
 */
export function workflowStuckCount(workflowName: string, minAttempts = 4): number {
  return (db.prepare(`
    SELECT COUNT(*) AS n FROM work_items
    WHERE status = 'failed' AND attempts >= ?
      AND job_name IN (SELECT job_name FROM workflow_jobs WHERE workflow_name = ?)
  `).get(minAttempts, workflowName) as { n: number }).n;
}
