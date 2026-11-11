import { engineHost, getJob as getJobDefinition } from './host.js';
import {
  addWorkflowLog,
  createWorkflowRun,
  setWorkflowRunSelectedRoots,
  finishWorkflowRun,
  getWorkflow,
  hasActiveWorkflowRun,
  hasJobAdvancedAnyItem,
  jobSoftStoppedThisRun,
  noForwardProgress,
  recordGateFailure,
  recordNotStarted,
  recordRunInput,
  recordSettledRun,
  recordReusedRun,
  recordRunArtifact,
  getWorkflowRun,
  getWorkflowRunRoots,
  setWorkflowRunResumedFrom,
  recordSkippedRun,
  rollUpWorkflowProgress,
  runChangedAnyItem,
  runCommittedFreshArtifact,
  runSoftStopped,
  workflowRunDidWork,
  selectPendingRoots,
  setRunNoop,
  workflowProgressSignature,
  workflowRunAdvancedAnyItem,
  type FinalWorkflowRunStatus,
  type WorkflowProgressSignature,
} from '../db/store.js';
import { type Dag, type Gate, buildDag, executeDag, gateFailurePrefix } from './dag.js';
import { config } from '../config.js';
import { bindWorkflowPorts, isPortsJob, workflowMode, type PortBinding } from './ports.js';
import { describeArtifact, resolveInput } from './resolve-inputs.js';
import { planResume, type ResumePlan } from './resume.js';
import { abortableSleep, runJobForWorkflow } from './executor.js';
import type { LogLevel, WorkflowDefinition, RunStatus } from './types.js';

/**
 * Default bounded parallelism for a workflow's independent stages (T156). When a
 * DAG has stages with no `dependsOn` edge between them (e.g. the movies
 * `franchise-gaps` + 8 recommender branches all hanging off `movie-snapshot`),
 * they become ready together and run concurrently up to this cap instead of
 * one-after-another. A workflow can override it via `maxConcurrency` (raise it for
 * a wide fan-out, or set `1` to force strict sequential order). Kept modest — each
 * parallel stage spawns its OWN child process, so this is a safe ceiling for a Mac
 * Mini; `executeDag` queues the excess. Strictly-linear workflows are unaffected
 * (only ever one stage is ready at a time anyway). Cross-process rate/quota
 * coordination is independent of this: paid stages still go through `callService`
 * → the shared SQLite `service_usage` meter, so concurrency can't let them
 * over-spend (the service quota is the governor regardless).
 */
export const DEFAULT_WORKFLOW_CONCURRENCY = 4;

/** Sentinel stored in DB / passed via API to express "no concurrency cap" (T201). */
export const UNLIMITED_CONCURRENCY_SENTINEL = 0;

/**
 * The EFFECTIVE bounded parallelism for a workflow (T169): the DB `max_concurrency`
 * (user override when set, else the synced manifest value) else the manifest's
 * `maxConcurrency` else the default. Reading the DB row keeps it user-editable +
 * code-reconciled. Shared by `runWorkflow` and the API's workflow payload so both
 * report the same number.
 *
 * A `max_concurrency` of `0` (UNLIMITED_CONCURRENCY_SENTINEL, T201) means "no cap":
 * returns `Infinity` so `executeDag` launches all ready stages without throttling.
 */
export function effectiveWorkflowConcurrency(def: WorkflowDefinition): number {
  const raw = getWorkflow(def.name)?.max_concurrency ?? def.maxConcurrency ?? DEFAULT_WORKFLOW_CONCURRENCY;
  return raw === UNLIMITED_CONCURRENCY_SENTINEL ? Infinity : raw;
}

/**
 * The EFFECTIVE notify-enabled flag for a workflow (T285): the DB `notify_enabled`
 * (user override when set, else the synced manifest value) else the manifest's
 * `notifyEnabled` else `true` (default ON). Reading the DB row keeps it
 * user-editable + code-reconciled. Shared by `runWorkflow` and the API's workflow
 * payload so both report the same value.
 */
export function effectiveWorkflowNotifyEnabled(def: WorkflowDefinition): boolean {
  const row = getWorkflow(def.name);
  if (row) return row.notify_enabled !== 0;
  return def.notifyEnabled !== false;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface WorkflowRunResult {
  workflowRunId: string | null;
  skipped?: boolean;
  reason?: string;
}

/**
 * In-memory registry of currently-executing workflow runs → their AbortController.
 * Populated when `runWorkflow` starts (so BOTH the scheduler path and the manual
 * `POST /api/workflows/:name/run` path register, since both flow through it) and
 * removed when the run settles. This is what makes a running workflow cancellable:
 * the API looks the run up here and calls `abort()`. It lives only in the daemon
 * process — a run not present here is not active in THIS process (already finished,
 * or orphaned by a restart) and so cannot be cancelled.
 */
const activeWorkflowRuns = new Map<string, AbortController>();

/**
 * Test-only seam (T524): lets a unit test simulate an exception escaping
 * `onSettle` (e.g. a SQLITE_BUSY thrown by `rollUpWorkflowProgress` under real
 * DB contention) WITHOUT corrupting the scratch DB itself. Mirrors the pattern
 * `notifier.ts` uses for `_setFetchForTest`. Always `null` outside tests.
 */
let onSettleThrowHookForTest: (() => void) | null = null;
export function _setOnSettleThrowHookForTest(hook: (() => void) | null): void {
  onSettleThrowHookForTest = hook;
}

/**
 * Per-workflow start guard (T105): the NAMES of workflows that have a run either
 * actively executing OR mid-start (claimed but whose DB row isn't written yet).
 * This is the in-process half of the atomic "one active run per workflow" check —
 * `runWorkflow` claims the name SYNCHRONOUSLY (before its first await) so two
 * near-simultaneous starts can't both pass the guard, even across the `await
 * inputKeys()` window before the run row exists. `hasActiveWorkflowRun` (DB) is the
 * other half, catching a still-running run from a prior tick. The set is keyed by
 * workflow NAME (a workflow may have only one active run); different workflows are
 * independent and may run concurrently.
 */
const startingWorkflows = new Set<string>();

/**
 * Whether the named workflow currently has a run in progress — either claimed/
 * starting in THIS process or recorded `running` in the DB. The authoritative,
 * race-safe predicate behind the "one active run per workflow" constraint (T105);
 * the API uses it to reject a duplicate start with 409 and `runWorkflow` uses it as
 * its own start guard.
 */
export function workflowRunInProgress(name: string): boolean {
  return startingWorkflows.has(name) || hasActiveWorkflowRun(name);
}

/**
 * Hold a run back while any workflow named in `def.after` has a run in progress.
 * Returns when none has, when the run is cancelled, or after
 * `config.afterMaxWaitMs`, whichever comes first. It only ever delays: the other
 * workflow's outcome is not looked at, and nothing here starts it.
 */
async function waitForWorkflows(
  def: WorkflowDefinition,
  log: (m: string, level?: LogLevel) => void,
  signal: AbortSignal,
): Promise<void> {
  const others = (def.after ?? []).filter((n) => n !== def.name);
  const busy = () => others.filter((n) => workflowRunInProgress(n));
  let waitingOn = busy();
  if (waitingOn.length === 0) return;
  const startedAt = Date.now();
  log(`Waiting for ${waitingOn.join(', ')} to finish before starting (this workflow reads their output).`);
  while (waitingOn.length > 0) {
    if (Date.now() - startedAt >= config.afterMaxWaitMs) {
      log(
        `Still running after ${Math.round(config.afterMaxWaitMs / 60_000)} min: ${waitingOn.join(', ')}. ` +
          `Starting anyway; this run may read output that is part-way through being rebuilt.`,
        'warn',
      );
      return;
    }
    if (await abortableSleep(config.afterPollMs, signal)) return;
    const now = busy();
    for (const done of waitingOn.filter((n) => !now.includes(n))) log(`${done} has finished.`);
    waitingOn = now;
  }
  log(`Waited ${Math.round((Date.now() - startedAt) / 1000)}s. Starting now.`);
}

/**
 * Whether the named workflow is CURRENTLY in the pre-DB-row "starting" window —
 * claimed in `startingWorkflows` (T105) but not yet past `createWorkflowRun`
 * (T595). A limited manual run whose root stage's `inputKeys()` is an expensive
 * live crawl (e.g. plex-language-fix's `discoverInputKeys()`, ~15 minutes for a
 * full Plex library walk) sits in this window for a long time with NO
 * `workflow_runs` row yet to show — this flag lets the dashboard surface a
 * transient "Starting…" indicator during that gap instead of showing nothing.
 * Purely a read of the existing in-process claim; no schema/DB change.
 *
 * The claim itself is held for the WHOLE run (released in `runWorkflow`'s
 * `finally`), so `startingWorkflows.has(name)` alone would stay true for the
 * entire run — leaving the dashboard stuck on "Starting…" even after the run row
 * exists and is `running`. Gate it on there being NO active DB run row yet, so
 * the flag flips off the moment `createWorkflowRun` writes the `running` row and
 * the dashboard falls back to its `last_run.status === 'running'` → "Running…"
 * state.
 */
export function isWorkflowStarting(name: string): boolean {
  return startingWorkflows.has(name) && !hasActiveWorkflowRun(name);
}

/**
 * Cancel a running workflow run by aborting its execution: in-flight member
 * children are hard-killed and no further stages launch (see `runWorkflow` /
 * `executeDag`). Returns false if the id isn't an active run in this process
 * (unknown or already terminal). The DB transition to 'cancelled' is written by
 * `runWorkflow` itself when it observes the abort, keeping the executor the sole
 * writer.
 */
export function cancelWorkflowRun(workflowRunId: string, reason = 'cancelled from the dashboard / API'): boolean {
  const controller = activeWorkflowRuns.get(workflowRunId);
  if (!controller) return false;
  // The reason rides on the signal and is recorded as the run's `end_reason`.
  controller.abort(reason);
  return true;
}

/** Whether a workflow run is currently executing in this process (registry membership). */
export function isWorkflowRunActive(workflowRunId: string): boolean {
  return activeWorkflowRuns.has(workflowRunId);
}

/**
 * The first member in topological (wave) order whose JobDefinition declares
 * `inputKeys()` — the ROOT STAGE that enumerates per-item originating inputs
 * (T094). Its `inputKeys()` are the candidate roots a limited run selects from.
 * Returns null when no member declares input keys (the workflow can't be limited).
 */
function findRootStage(dag: Dag): string | null {
  for (const wave of dag.waves) {
    for (const job of wave) {
      if (getJobDefinition(job)?.inputKeys) return job;
    }
  }
  return null;
}

/**
 * Run a workflow: execute its DAG (one topological pass), optionally repeating in
 * cycles until no retryable work remains. The daemon owns this (it's the DB
 * writer). Member job runs link to the workflow run; the workflow emits per-stage
 * + aggregate notifications and writes framework logs.
 *
 * `opts.limit` (T094) caps a MANUAL run to N originating inputs: the framework
 * selects the first N pending roots from the root stage's `inputKeys()` at run
 * start, freezes them on the run row, and each stage filters to `ctx.rootAllowed`.
 * All fan-out of a selected root runs to completion. Unset / scheduled runs are
 * unlimited (today's behaviour, unchanged).
 */
export interface RunWorkflowOptions {
  /** Cap a manual run to this many originating inputs (T094). */
  limit?: number;
  /**
   * Resume an earlier run of this workflow: reuse the result of every stage that
   * succeeded there and whose outputs are still intact, and run the rest. See
   * `resume.ts` for exactly when a stage is reused.
   */
  resumeFrom?: string;
}

export async function runWorkflow(
  def: WorkflowDefinition,
  trigger: 'schedule' | 'manual',
  opts: RunWorkflowOptions = {},
): Promise<WorkflowRunResult> {
  // Atomic per-workflow start guard (T105): check + claim run SYNCHRONOUSLY with no
  // await between them, so two near-simultaneous starts of the SAME workflow can't
  // both pass — the second sees the claimed name and bails. The claim is held for the
  // whole run (released in the finally) so the window before the DB row exists (the
  // `await inputKeys()` for a limited run) is also covered. DIFFERENT workflows have
  // independent names and still run concurrently.
  if (workflowRunInProgress(def.name)) {
    return { workflowRunId: null, skipped: true, reason: 'already running' };
  }
  startingWorkflows.add(def.name);
  try {
    return await runWorkflowInner(def, trigger, opts);
  } finally {
    startingWorkflows.delete(def.name);
  }
}

async function runWorkflowInner(
  def: WorkflowDefinition,
  trigger: 'schedule' | 'manual',
  opts: RunWorkflowOptions = {},
): Promise<WorkflowRunResult> {
  let dag: Dag;
  try {
    dag = buildDag(def.jobs);
  } catch (e) {
    const id = createWorkflowRun(def.name, trigger);
    addWorkflowLog(id, `Invalid workflow DAG: ${e instanceof Error ? e.message : e}`, 'error');
    finishWorkflowRun(id, 'failed', { endReason: `invalid workflow DAG: ${msg(e)}` });
    return { workflowRunId: id };
  }

  // The boundaries between stages are the port bindings: for each input of each
  // stage, which upstream stage feeds it. Each is resolved (against what that
  // producer committed in THIS run) just before the consumer runs. The registry
  // validates the bindings at load; this is the same check again for a definition
  // handed to runWorkflow directly (tests). A workflow whose stages declare no
  // ports has no boundaries to check: its stages just run in dependency order.
  const mode = workflowMode(def, getJobDefinition);
  const bound = mode === 'ports' ? bindWorkflowPorts(def, getJobDefinition) : null;
  if (bound && bound.errors.length > 0) {
    const id = createWorkflowRun(def.name, trigger);
    addWorkflowLog(id, `Invalid workflow ports:\n${bound.errors.map((e) => `  • ${e}`).join('\n')}`, 'error');
    finishWorkflowRun(id, 'failed', { endReason: `invalid workflow ports: ${bound.errors[0]}` });
    return { workflowRunId: id };
  }
  const inboundBindings = new Map<string, PortBinding[]>();
  for (const b of bound?.bindings ?? []) (inboundBindings.get(b.consumer) ?? inboundBindings.set(b.consumer, []).get(b.consumer)!).push(b);
  const boundaryCount = bound?.bindings.length ?? 0;

  const total = dag.nodes.length;
  const memberNames = def.jobs.map((j) => j.job);
  const minAttempts = def.minAttempts ?? 4;
  const maxCycles = def.repeatUntilStable ? Math.max(1, def.maxCycles ?? 1) : 1;

  // Run-limit selection (T094) via the OPTIMISTIC-ROW path: the run row is created
  // UP-FRONT (below), so a *limited* run is visible immediately as a `running` run
  // while it discovers its originating inputs — instead of the old invisible
  // pre-DB-row "Starting…" window, which produced no artifact for the whole
  // (potentially long) discovery scan AND silently 409-blocked every manual run in
  // the meantime. The selected roots are frozen onto that existing row once the scan
  // finishes, BEFORE any member stage spawns. Unset limit → unlimited (null).
  let runLimit: number | null = null;
  let limitNote = '';
  if (opts.limit && opts.limit > 0) {
    if (findRootStage(dag)) {
      runLimit = opts.limit;
    } else {
      // Defensive: the API rejects a limit on a non-limitable workflow, so this is
      // only reachable if called directly. Fall back to unlimited rather than block.
      limitNote = ` · limit ${opts.limit} ignored (no stage declares input keys)`;
    }
  }

  // A resume runs over the same inputs as the run it resumes: it takes that run's
  // limit and frozen roots as they are, instead of selecting afresh.
  const resumed = opts.resumeFrom ? getWorkflowRun(opts.resumeFrom) : undefined;
  const resumedRoots = resumed ? getWorkflowRunRoots(resumed.id) : null;
  if (resumed) runLimit = resumedRoots ? (resumed.run_limit ?? resumedRoots.length) : null;

  const workflowRunId = createWorkflowRun(def.name, trigger, runLimit, resumedRoots);
  if (resumed) setWorkflowRunResumedFrom(workflowRunId, resumed.id);
  const controller = new AbortController();
  activeWorkflowRuns.set(workflowRunId, controller);
  const log = (m: string, level: LogLevel = 'info') => addWorkflowLog(workflowRunId, m, level);
  // Set once finishWorkflowRun has been called on ANY path (normal or the
  // catch-all below), so a throw that escapes AFTER the normal finalisation
  // already ran can't double-finish the run.
  let finished = false;

  // Wait for the workflows this one reads from (`after`) before doing anything
  // else, discovery included, so everything below sees their finished output.
  // (Not awaited at all without `after`: a run with nothing to wait for must not
  // yield here, since a limited run's discovery is expected to start at once.)
  if (def.after?.length) await waitForWorkflows(def, log, controller.signal);

  // Discover + freeze the selected roots now that the row exists and is visibly
  // `running`. A throw (inputKeys() rejecting on a live API call) fails THIS row —
  // no separate pre-row row needed anymore — and returns. The run is also
  // cancellable during this window now, since the row already exists (the abort
  // takes effect once the scan returns and gates the DAG below).
  let emptySelectionWarning: string | null = null;
  if (resumed && resumedRoots) {
    limitNote = ` · limited to the ${resumedRoots.length} originating input(s) of the run it resumes`;
  } else if (runLimit && !controller.signal.aborted) {
    const rootStage = findRootStage(dag)!;
    log(`Discovering originating inputs for a limited run (limit ${runLimit}) via "${rootStage}"…`);
    try {
      const candidates = await getJobDefinition(rootStage)!.inputKeys!();
      // "Pending" is propagation through the TERMINAL stage (the last DAG wave),
      // not merely past the entry stage (T163) — so a root with un-attempted
      // downstream work (e.g. resolved-but-not-enriched) is correctly selectable.
      const terminalJobs = dag.waves[dag.waves.length - 1] ?? [];
      // Stages that can decide an item is finished without the final stage ever
      // recording it say so through `settles`.
      const settles = new Map<string, (detail: Record<string, unknown>) => boolean>();
      for (const name of memberNames) {
        const fn = getJobDefinition(name)?.settles;
        if (fn) settles.set(name, fn);
      }
      const selectedRoots = selectPendingRoots(memberNames, terminalJobs, candidates, runLimit, minAttempts, settles);
      setWorkflowRunSelectedRoots(workflowRunId, selectedRoots);
      limitNote = ` · limited to ${runLimit} originating input(s): ${selectedRoots.length ? selectedRoots.join(', ') : '(none pending)'}`;
      // Guard the silent no-op (T163): a limit that selects 0 roots from a
      // non-empty candidate set would otherwise "succeed" doing nothing. Surface
      // it loudly so a backlog catch-up run that found nothing selectable is visible.
      if (selectedRoots.length === 0 && candidates.length > 0) {
        emptySelectionWarning = `Run limit ${runLimit} requested but 0 originating inputs were selectable — ${candidates.length} candidate(s), all already complete (propagated through the terminal stage, or permanently stuck). Nothing will run this run.`;
      }
    } catch (e) {
      log(`Failed to resolve input keys for root stage "${rootStage}": ${e instanceof Error ? e.message : e}`, 'error');
      finished = true;
      finishWorkflowRun(workflowRunId, 'failed', { endReason: `could not discover inputs for a limited run: ${msg(e)}` });
      activeWorkflowRuns.delete(workflowRunId);
      return { workflowRunId };
    }
  }

  try {
  log(`Workflow "${def.name}" started · ${total} job(s) · ${boundaryCount} input(s) · trigger=${trigger}${def.repeatUntilStable ? ` · repeatUntilStable (maxCycles=${maxCycles})` : ''}${limitNote}`);
  if (emptySelectionWarning) log(emptySelectionWarning, 'warn');

  // Resume: work out which stages' results from the earlier run can be reused.
  let resume: ResumePlan | null = null;
  if (opts.resumeFrom) {
    if (!resumed || resumed.workflow_name !== def.name) {
      log(`Cannot resume from run ${opts.resumeFrom}: it is not a run of "${def.name}". Running every stage.`, 'warn');
    } else if (mode !== 'ports') {
      log(`Cannot resume: "${def.name}" is not a ports workflow, so its stages' outputs were never recorded. Running every stage.`, 'warn');
    } else {
      resume = planResume(dag, resumed.id, getJobDefinition);
      log(`Resuming run ${resumed.id} (${resumed.status}): reusing ${resume.reusable.size} of ${total} stage(s).`);
      for (const [job] of resume.reusable) log(`  ↺ ${job}: its result from that run is reused`);
      for (const [job, why] of resume.rerun) log(`  ▶ ${job} runs again: ${why}`);
    }
  }

  // No-forward-progress detection across repeatUntilStable cycles (T112).
  let prevSig: WorkflowProgressSignature | null = null;

  // Effective bounded parallelism (T169): read the DB `max_concurrency` FRESH each
  // run — it is the user override when set, else the synced manifest value, else
  // T156's default. Reading it here (not `def.maxConcurrency`) means a dashboard
  // edit takes effect on the NEXT run with no daemon restart, mirroring the live
  // schedule/enabled checks.
  const effectiveConcurrency = effectiveWorkflowConcurrency(def);

  // Whether any member declares inputKeys() — only limitable workflows get noop
  // detection via work_item_runs. Non-limitable workflows (no static input list)
  // re-scan each run by design; marking them noop would misfire (T258).
  const isLimitableWorkflow = !!findRootStage(dag);
  // Which member jobs were detected as noops (succeeded but advanced no items) and
  // which STALLED (soft-stopped having completed ZERO items). Both are PER CYCLE:
  // they are reset at the top of each repeatUntilStable cycle, and the run's
  // outcome is judged on the FINAL cycle (as its member statuses already are).
  // They used to live for the whole run, so a stage that was a noop in cycle 1
  // and then FAILED in cycle 2 had its "✗ failed" log line suppressed and its
  // progress message read "skipped (noop)".
  let noopJobs = new Set<string>();
  let stalledJobs = new Set<string>();
  /** job → epoch ms it became ready this cycle (deps settled; waiting for a slot). */
  const queuedAt = new Map<string, number>();

  let lastStatuses = new Map<string, RunStatus>();
  let cyclesRun = 0;
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    if (def.repeatUntilStable) log(`──── cycle ${cycle}/${maxCycles} ────`);
    let settled = 0;
    cyclesRun = cycle;
    noopJobs = new Set<string>();
    stalledJobs = new Set<string>();
    queuedAt.clear();

    lastStatuses = await executeDag(dag, {
      concurrency: effectiveConcurrency,
      signal: controller.signal,
      onReady: (job) => { queuedAt.set(job, Date.now()); },
      runOne: async (job) => {
        const meta = { cycle, queuedAtMs: queuedAt.get(job) ?? Date.now() };
        const jd = getJobDefinition(job);
        if (!jd) {
          log(`job "${job}" has no definition — failing it`, 'error');
          // Still leave a row: every stage of every run gets a recorded outcome.
          recordSettledRun(job, workflowRunId, 'failed', `job "${job}" has no definition in the registry`, 'gate-failed', meta);
          return 'failed';
        }
        // Resumed from an earlier run, and this stage's result there is still good:
        // do not run it. Its artifacts are re-recorded under THIS run (marked as
        // reused), so the stages after it resolve their inputs exactly as usual.
        // Only in the first cycle: a later cycle is new work.
        const reuse = cycle === 1 ? resume?.reusable.get(job) : undefined;
        if (reuse) {
          const note = `reused from run ${opts.resumeFrom}`;
          const reusedRunId = recordReusedRun(job, workflowRunId, note, meta);
          for (const a of reuse.artifacts) {
            recordRunArtifact({
              workflowRunId, runId: reusedRunId, cycle, jobName: job, port: a.port, artifactKey: a.artifact_key, storage: a.storage,
              path: a.path, sha256: a.sha256, bytes: a.bytes, mtimeMs: a.mtime_ms, itemCount: a.item_count,
              fresh: false, ok: true,
              check: a.check_json ? JSON.parse(a.check_json) : undefined,
              summary: a.summary_json ? JSON.parse(a.summary_json) : undefined,
              inlineJson: a.inline_json, note,
            });
          }
          // Its inputs too. Everything upstream of a reused stage is reused as well,
          // so each input resolves to an artifact just carried over into THIS run,
          // and is confirmed to be what is on disk now. Recording that keeps the
          // run's picture whole: the gates into a reused stage show as passed, and
          // its Inputs list what it was given, instead of both being blank.
          for (const b of inboundBindings.get(job) ?? []) {
            const t0 = Date.now();
            const r = resolveInput(workflowRunId, cycle, b, getJobDefinition(b.producer)?.outputs?.[b.producerPort]?.artifact.files);
            if (!r.ok) continue; // planResume has already checked this; never fail a stage that is not running
            recordRunInput({
              workflowRunId, cycle, jobName: job, port: b.port, producerJob: b.producer, artifactKey: b.artifactKey,
              artifactId: r.artifact?.id ?? null, ok: true, reason: null, durationMs: Date.now() - t0,
            });
          }
          log(`↺ ${job} not run: ${note} (${reuse.artifacts.length} output(s) carried over)`);
          return 'success';
        }
        const gateStart = Date.now();
        const failures: Array<{ gate: Gate; detail: string }> = [];
        // The gate: resolve every input to what its producer committed in THIS run
        // and cycle, check it is still what is on disk, and record the verdict
        // (run_inputs) as it is reached, so the run page shows what was checked at
        // run time. A failure is a first-class failed run: the stage never spawns.
        // EVERY input is resolved, even after one fails: on a fan-in the useful
        // answer is "which of the 8 inputs are bad", not just the first.
        for (const b of inboundBindings.get(job) ?? []) {
          const gate: Gate = { key: b.artifactKey, producer: b.producer, consumer: b.consumer };
          const t0 = Date.now();
          const r = resolveInput(workflowRunId, cycle, b, getJobDefinition(b.producer)?.outputs?.[b.producerPort]?.artifact.files);
          recordRunInput({
            workflowRunId,
            cycle,
            jobName: job,
            port: b.port,
            producerJob: b.producer,
            artifactKey: b.artifactKey,
            artifactId: r.artifact?.id ?? null,
            ok: r.ok,
            reason: r.reason ?? null,
            durationMs: Date.now() - t0,
          });
          if (!r.ok) {
            const detail = `${gateFailurePrefix(gate)}: ${r.reason}`;
            log(`⨯ input "${b.port}" of ${job} — ${detail}`, 'error');
            failures.push({ gate, detail });
            continue;
          }
          const what = r.artifact ? describeArtifact(r.artifact) : '';
          log(`✓ input "${b.port}" of ${job} ← ${b.producer} · artifact "${b.artifactKey}"${what ? ` (${what})` : ''}`);
        }
        const gateMs = Date.now() - gateStart;
        if (controller.signal.aborted) {
          recordNotStarted(job, workflowRunId, 'not started: the workflow run was cancelled during its gate checks', 'not-started-cancelled', { ...meta, gateMs });
          return 'cancelled';
        }
        if (failures.length > 0) {
          // The first failing gate leads the error (classifyGates matches on that
          // prefix); any others follow so none is hidden.
          recordGateFailure(job, workflowRunId, failures.map((f) => f.detail).join(' | '), { ...meta, gateMs });
          return 'failed';
        }
        const { runId, status } = await runJobForWorkflow(jd, workflowRunId, controller.signal, {
          ...meta,
          gateMs,
          workflowName: def.name,
          workflowTrigger: trigger,
        });
        // Noop detection (T258): for limitable workflows, a stage that succeeds
        // without advancing any work items (no markWorkItem calls during this run)
        // is a noop — all items were already done or quota-soft-stopped. Update the
        // DB run record to 'skipped' so the dashboard communicates "nothing to do"
        // instead of "success". The return value stays 'success' so executeDag
        // doesn't cascade-skip dependents — the noop is a per-stage annotation,
        // not a workflow-level failure.
        // Did the stage DO anything? A ports stage is judged on what its own
        // attempt recorded: it committed an output with new content, or changed a
        // ledger item. So nothing has to write a row just to avoid being called a
        // noop, and re-recording an unchanged catalogue does not count as work. A
        // legacy stage is judged the old way (any ledger row touched this run).
        const ports = isPortsJob(jd);
        const didWork = !runId ? true
          : ports ? runCommittedFreshArtifact(runId) || runChangedAnyItem(runId)
          : hasJobAdvancedAnyItem(workflowRunId, job);
        if (status === 'success' && runId && isLimitableWorkflow && !didWork) {
          const stalledNow = ports ? runSoftStopped(runId) : jobSoftStoppedThisRun(workflowRunId, job);
          setRunNoop(runId, stalledNow ? 'stalled' : 'noop');
          noopJobs.add(job);
          // Two very different shapes of "advanced nothing", and conflating them is
          // what let a hard-broken stage report success indefinitely:
          //   • soft-stopped → it HAD work queued and completed none of it. That is
          //     a STALL (an upstream refusal, an exhausted ceiling), not a quiet
          //     day, and it must colour the whole run so the push says so.
          //   • no soft stop → genuinely nothing to do. Benign, stays success.
          if (stalledNow) {
            stalledJobs.add(job);
            log(
              `⊙ ${job} → STALLED (stopped early having completed 0 items — it had work queued ` +
              `but an external limit or refusal blocked every one; see the stage log for the cause)`,
              'warn',
            );
          } else {
            log(`⊙ ${job} → skipped (nothing to do — all items already processed or no items in scope)`, 'warn');
          }
        }
        return status;
      },
      onStart: (job) => log(`▶ ${job} started`),
      onSettle: async (job, s) => {
        settled++;
        const label = noopJobs.has(job) ? 'skipped (noop)' : s;
        // Test-only seam (mirrors notifier.ts's _setFetchForTest): lets a test
        // simulate onSettle's DB write throwing (e.g. a SQLITE_BUSY from
        // rollUpWorkflowProgress under real contention) without corrupting the
        // scratch DB itself. No-op (null) in production.
        onSettleThrowHookForTest?.();
        rollUpWorkflowProgress(workflowRunId, `${settled}/${total} stages (${job} ${label})`);
        if (!noopJobs.has(job)) {
          log(`${s === 'success' ? '✓' : '✗'} ${job} → ${s}`, s === 'success' ? 'info' : 'warn');
        }
      },
      onSkip: async (job, reason) => {
        settled++;
        recordSkippedRun(job, workflowRunId, `skipped: ${reason}`, 'upstream-skipped', { cycle, queuedAtMs: Date.now() });
        rollUpWorkflowProgress(workflowRunId, `${settled}/${total} stages (${job} skipped)`);
        log(`⊘ ${job} skipped — ${reason}`, 'warn');
      },
    });

    // Cancelled mid-run — stop cycling (the in-flight stage was already killed
    // and drained by executeDag) and fall through to the cancelled finalisation.
    // Stages executeDag never reached are absent from its status map; give each a
    // row and a log line so the run page shows "not started", not a blank.
    if (controller.signal.aborted) {
      for (const job of dag.nodes) {
        if (lastStatuses.has(job)) continue;
        recordNotStarted(job, workflowRunId, 'not started: the workflow run was cancelled first', 'not-started-cancelled', { cycle });
        log(`⊘ ${job} not started — the workflow run was cancelled before it was reached`, 'warn');
      }
      break;
    }

    if (!def.repeatUntilStable) break;
    const sig = workflowProgressSignature(memberNames, minAttempts);
    log(`cycle ${cycle} complete · retryable work left = ${sig.retryable}`);
    if (sig.retryable === 0) {
      log('Stable — no retryable work remaining.');
      break;
    }
    // No-forward-progress early stop (T112): if a whole cycle changed NOTHING in
    // the member work-item ledger (same row count, same total attempts) and the
    // retryable count didn't drop, the remaining "retryable" items aren't actually
    // advancing — e.g. a genuinely-unfindable input frozen below maxAttempts. Spinning
    // to maxCycles would just re-run every stage for nothing (and, before the
    // notification dedup, spam ntfy). Stop here and surface that the items need
    // attention.
    if (noForwardProgress(prevSig, sig)) {
      log(
        `No forward progress this cycle — ${sig.retryable} item(s) still flagged retryable but nothing advanced ` +
          `(no work item attempted/succeeded/failed). Stopping early rather than spinning to maxCycles=${maxCycles}; ` +
          `the remaining item(s) need attention (e.g. an unfindable input) — unstick or ignore them from the dashboard.`,
        'warn',
      );
      break;
    }
    prevSig = sig;
    if (cycle < maxCycles && (def.cycleSleepMs ?? 0) > 0) {
      log(`sleeping ${Math.round((def.cycleSleepMs ?? 0) / 1000)}s before next cycle…`);
      // Abortable: a cancel during the pause ends the run now, not after the sleep.
      if (await abortableSleep(def.cycleSleepMs ?? 0, controller.signal)) break;
    }
  }

  // A cancelled run is recorded 'cancelled' regardless of the members' tally —
  // the abort is the authoritative outcome (in-flight members were killed and
  // settled 'cancelled'; not-yet-started stages never spawned).
  // For limitable workflows a run where NO stage advanced any work item is a
  // whole-run noop → settle as 'skipped' (T258). This can only happen when
  // selectPendingRoots found no pending roots (emptySelectionWarning path) or
  // when every stage found its items already done. Non-limitable workflows re-scan
  // each run by design and always advance something (or fail), so the guard is
  // isLimitableWorkflow. 'success' stages whose individual runs were nooped still
  // appear as 'success' in lastStatuses (the runOne return value is unchanged);
  // workflowRunAdvancedAnyItem is the authoritative check.
  const statuses = [...lastStatuses.values()];
  const anyRealWork = !isLimitableWorkflow || (bound ? workflowRunDidWork(workflowRunId) : workflowRunAdvancedAnyItem(workflowRunId));
  // A STALLED stage (soft-stopped having completed zero items) downgrades an
  // otherwise-clean run to 'partial'. Every member job genuinely returned
  // 'success' — it caught its own quota/refusal error and stopped politely — so
  // without this the run settles 'success' and the push says ✅ even though the
  // stage achieved nothing. That is exactly how the places workflow reported
  // success for 18 consecutive nights after its Gemini credits ran dry. 'partial'
  // maps to ⚠️ + 'high' priority in notifyWorkflow, so a stall actually reaches
  // the phone instead of blending into the nightly green ticks.
  const stalled = stalledJobs.size > 0;
  const status: FinalWorkflowRunStatus = controller.signal.aborted
    ? 'cancelled'
    : statuses.length === 0 ? 'failed'
    : !anyRealWork && statuses.every((s) => s === 'success') && !stalled ? 'skipped'
    : statuses.every((s) => s === 'success') ? (stalled ? 'partial' : 'success')
    : statuses.some((s) => s === 'success') ? 'partial'
    : 'failed';
  if (stalled) {
    log(
      `Workflow "${def.name}" is PARTIAL — ${stalledJobs.size} stage(s) stalled: ${[...stalledJobs].join(', ')}. ` +
      `Each stopped early without completing a single item.`,
      'warn',
    );
  }
  finished = true;
  const cancelReason = controller.signal.aborted
    ? (typeof controller.signal.reason === 'string' ? controller.signal.reason : 'cancelled')
    : null;
  finishWorkflowRun(workflowRunId, status, { endReason: cancelReason, cycles: cyclesRun });
  log(status === 'cancelled'
    ? `Workflow "${def.name}" cancelled${cancelReason ? ` (${cancelReason})` : ''}`
    : `Workflow "${def.name}" finished: ${status}`);
  // notifyWorkflow accepts WorkflowRunStatus; a 'skipped' (noop) run is
  // quiet/benign — map it to 'success' for the aggregate notification.
  const notifyStatus = status === 'skipped' ? 'success' : status;
  // Gate the single T189 aggregate notification on the EFFECTIVE notifyEnabled
  // (T285) — user override when set, else the manifest default (true). Read fresh
  // each run so a dashboard toggle takes effect on the NEXT run, no restart.
  if (effectiveWorkflowNotifyEnabled(def)) {
    await engineHost().notify?.({ workflow: def, workflowRunId, status: notifyStatus, log });
  } else {
    log(`Notifications disabled for workflow "${def.name}" — skipping push notification`);
  }
  return { workflowRunId };
  } catch (err) {
    // Any exception escaping the run body (e.g. a SQLITE_BUSY thrown by
    // rollUpWorkflowProgress in onSettle, or a rejecting runOne bubbling out of
    // executeDag) would otherwise leave the workflow_runs row wedged at
    // status='running' forever — blocking future manual runs (409), skipping
    // scheduled fires, and requiring a daemon restart to recover. Abort any
    // in-flight member (hard-killed via the existing SIGTERM→SIGKILL path) and
    // fail the run explicitly so the workflow is immediately re-runnable — the
    // error is logged loudly to the run, not swallowed silently.
    controller.abort('engine error');
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort: this is the catch-all, so a logging failure must not mask the
    // original error or stop the run being finalised below.
    try {
      log(`Workflow "${def.name}" run failed with an unhandled error: ${err instanceof Error ? (err.stack ?? message) : message}`, 'error');
    } catch { /* the DB is the likely culprit; fall through to finalise */ }
    if (!finished) {
      finished = true;
      finishWorkflowRun(workflowRunId, 'failed', { endReason: `unhandled engine error: ${message}` });
      // A run that died this way used to end silently. It is a failure like any
      // other, so it reaches the phone too (best-effort: never throw from here).
      try {
        if (effectiveWorkflowNotifyEnabled(def)) await engineHost().notify?.({ workflow: def, workflowRunId, status: 'failed', log });
      } catch { /* notification is best-effort on this path */ }
    }
    return { workflowRunId };
  } finally {
    activeWorkflowRuns.delete(workflowRunId);
  }
}
