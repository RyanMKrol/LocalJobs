import { getJobDefinition } from '../jobs/registry.js';
import {
  addWorkflowLog,
  createWorkflowRun,
  finishWorkflowRun,
  getWorkflow,
  hasActiveWorkflowRun,
  selectPendingRoots,
  workflowProgressSignature,
  noForwardProgress,
  recordGateFailure,
  recordSkippedRun,
  rollUpWorkflowProgress,
  type WorkflowProgressSignature,
} from '../db/store.js';
import { type Dag, type Gate, buildDag, deriveGates, executeDag, gateFailurePrefix } from './dag.js';
import { runJobForWorkflow } from './executor.js';
import { notifyWorkflow } from './notifier.js';
import type { LogLevel, WorkflowDefinition, WorkflowRunStatus, RunStatus } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Enforce one gate: run the producer's `produces[key]` contract (output is
 * well-formed) and the consumer's `consumes[key]` contract (input is acceptable),
 * whichever are declared. A check that returns `ok:false` or throws contributes
 * its violations. Returns the merged verdict so the boundary fails LOUD with the
 * exact drift rather than passing bad data downstream.
 */
/**
 * The human-readable assertions a gate enforces — the producer's `produces[key]`
 * and the consumer's `consumes[key]` contract descriptions, whichever are
 * declared. Logged before each check so the run's framework log says what the
 * gate is verifying (not just pass/fail). Pure lookup; runs no checks.
 */
function gateAssertions(gate: Gate): string[] {
  const out: string[] = [];
  const p = getJobDefinition(gate.producer)?.produces?.find((c) => c.key === gate.key)?.description;
  const c = getJobDefinition(gate.consumer)?.consumes?.find((c) => c.key === gate.key)?.description;
  if (p) out.push(`output (from ${gate.producer}): ${p}`);
  if (c) out.push(`input (to ${gate.consumer}): ${c}`);
  return out;
}

async function enforceGate(gate: Gate): Promise<{ ok: boolean; violations: string[] }> {
  const producer = getJobDefinition(gate.producer);
  const consumer = getJobDefinition(gate.consumer);
  const sides: Array<['output' | 'input', ReturnType<typeof getJobDefinition>, 'produces' | 'consumes']> = [
    ['output', producer, 'produces'],
    ['input', consumer, 'consumes'],
  ];
  const violations: string[] = [];
  for (const [side, def, field] of sides) {
    const contract = def?.[field]?.find((c) => c.key === gate.key);
    if (!contract) continue;
    try {
      const r = await contract.check();
      if (!r.ok) violations.push(...(r.violations?.length ? r.violations : [`${gate.key}: ${side} contract not satisfied`]));
    } catch (e) {
      violations.push(`${gate.key}: ${side} check threw — ${msg(e)}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

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
 * Cancel a running workflow run by aborting its execution: in-flight member
 * children are hard-killed and no further stages launch (see `runWorkflow` /
 * `executeDag`). Returns false if the id isn't an active run in this process
 * (unknown or already terminal). The DB transition to 'cancelled' is written by
 * `runWorkflow` itself when it observes the abort, keeping the executor the sole
 * writer.
 */
export function cancelWorkflowRun(workflowRunId: string): boolean {
  const controller = activeWorkflowRuns.get(workflowRunId);
  if (!controller) return false;
  controller.abort();
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
export async function runWorkflow(
  def: WorkflowDefinition,
  trigger: 'schedule' | 'manual',
  opts: { limit?: number } = {},
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
  opts: { limit?: number } = {},
): Promise<WorkflowRunResult> {
  let dag: Dag;
  try {
    dag = buildDag(def.jobs);
  } catch (e) {
    const id = createWorkflowRun(def.name, trigger);
    addWorkflowLog(id, `Invalid workflow DAG: ${e instanceof Error ? e.message : e}`, 'error');
    finishWorkflowRun(id, 'failed');
    return { workflowRunId: id };
  }

  // Derive the typed-artifact gates between dependent stages from each member's
  // declared produces/consumes keys. Inbound gates are grouped by consumer so a
  // job's contracts are checked the moment it's about to run.
  const produces = new Map<string, string[]>();
  const consumes = new Map<string, string[]>();
  for (const node of dag.nodes) {
    const jd = getJobDefinition(node);
    produces.set(node, (jd?.produces ?? []).map((c) => c.key));
    consumes.set(node, (jd?.consumes ?? []).map((c) => c.key));
  }
  const gates = deriveGates(dag, produces, consumes);
  const inboundGates = new Map<string, Gate[]>();
  for (const g of gates) (inboundGates.get(g.consumer) ?? inboundGates.set(g.consumer, []).get(g.consumer)!).push(g);

  const total = dag.nodes.length;
  const memberNames = def.jobs.map((j) => j.job);
  const minAttempts = def.minAttempts ?? 4;
  const maxCycles = def.repeatUntilStable ? Math.max(1, def.maxCycles ?? 1) : 1;

  // Run-limit selection (T094): for a manual limit, pick the first N pending
  // originating-input roots from the root stage's inputKeys() and freeze them on
  // the run row. The allowlist is computed ONCE here (reused across cycles); each
  // member child reads it via the run row. Unset limit → unlimited (null).
  let runLimit: number | null = null;
  let selectedRoots: string[] | null = null;
  let limitNote = '';
  let emptySelectionWarning: string | null = null;
  if (opts.limit && opts.limit > 0) {
    runLimit = opts.limit;
    const rootStage = findRootStage(dag);
    if (rootStage) {
      const candidates = await getJobDefinition(rootStage)!.inputKeys!();
      // "Pending" is propagation through the TERMINAL stage (the last DAG wave),
      // not merely past the entry stage (T163) — so a root with un-attempted
      // downstream work (e.g. resolved-but-not-enriched) is correctly selectable.
      const terminalJobs = dag.waves[dag.waves.length - 1] ?? [];
      selectedRoots = selectPendingRoots(memberNames, terminalJobs, candidates, runLimit, minAttempts);
      limitNote = ` · limited to ${runLimit} originating input(s): ${selectedRoots.length ? selectedRoots.join(', ') : '(none pending)'}`;
      // Guard the silent no-op (T163): a limit that selects 0 roots from a
      // non-empty candidate set would otherwise "succeed" doing nothing. Surface
      // it loudly so a backlog catch-up run that found nothing selectable is visible.
      if (selectedRoots.length === 0 && candidates.length > 0) {
        emptySelectionWarning = `Run limit ${runLimit} requested but 0 originating inputs were selectable — ${candidates.length} candidate(s), all already complete (propagated through the terminal stage, or permanently stuck). Nothing will run this run.`;
      }
    } else {
      // Defensive: the API rejects a limit on a non-limitable workflow, so this is
      // only reachable if called directly. Fall back to unlimited rather than block.
      limitNote = ` · limit ${runLimit} ignored (no stage declares input keys)`;
      runLimit = null;
    }
  }

  const workflowRunId = createWorkflowRun(def.name, trigger, runLimit, selectedRoots);
  const controller = new AbortController();
  activeWorkflowRuns.set(workflowRunId, controller);
  const log = (m: string, level: LogLevel = 'info') => addWorkflowLog(workflowRunId, m, level);

  log(`Workflow "${def.name}" started · ${total} job(s) · ${gates.length} gate(s) · trigger=${trigger}${def.repeatUntilStable ? ` · repeatUntilStable (maxCycles=${maxCycles})` : ''}${limitNote}`);
  if (emptySelectionWarning) log(emptySelectionWarning, 'warn');

  // No-forward-progress detection across repeatUntilStable cycles (T112).
  let prevSig: WorkflowProgressSignature | null = null;

  // Effective bounded parallelism (T169): read the DB `max_concurrency` FRESH each
  // run — it is the user override when set, else the synced manifest value, else
  // T156's default. Reading it here (not `def.maxConcurrency`) means a dashboard
  // edit takes effect on the NEXT run with no daemon restart, mirroring the live
  // schedule/enabled checks.
  const effectiveConcurrency = effectiveWorkflowConcurrency(def);

  let lastStatuses = new Map<string, RunStatus>();
  try {
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    if (def.repeatUntilStable) log(`──── cycle ${cycle}/${maxCycles} ────`);
    let settled = 0;

    lastStatuses = await executeDag(dag, {
      concurrency: effectiveConcurrency,
      signal: controller.signal,
      runOne: async (job) => {
        const jd = getJobDefinition(job);
        if (!jd) {
          log(`job "${job}" has no definition — failing it`, 'error');
          return 'failed';
        }
        // Validation gate: every inbound contract from a (now-succeeded) upstream
        // is checked BEFORE the consumer runs. A violation is a first-class failed
        // run — the consumer never spawns and the drift is surfaced + notified,
        // so bad data is stopped at the exact boundary.
        for (const gate of inboundGates.get(job) ?? []) {
          const asserts = gateAssertions(gate);
          const suffix = asserts.length ? ` · ${asserts.join('; ')}` : '';
          log(`⛒ checking gate [${gate.producer} → ${gate.consumer}] artifact "${gate.key}"${suffix}`);
          const verdict = await enforceGate(gate);
          if (!verdict.ok) {
            const detail = `${gateFailurePrefix(gate)}: ${verdict.violations.join('; ')}`;
            log(`⨯ ${detail}`, 'error');
            recordGateFailure(job, workflowRunId, detail);
            return 'failed';
          }
          log(`✓ gate ok [${gate.producer} → ${gate.consumer}] artifact "${gate.key}"${suffix}`);
        }
        const { status } = await runJobForWorkflow(jd, workflowRunId, controller.signal);
        return status;
      },
      onStart: (job) => log(`▶ ${job} started`),
      onSettle: async (job, s) => {
        settled++;
        rollUpWorkflowProgress(workflowRunId, `${settled}/${total} stages (${job} ${s})`);
        log(`${s === 'success' ? '✓' : '✗'} ${job} → ${s}`, s === 'success' ? 'info' : 'warn');
      },
      onSkip: async (job, reason) => {
        settled++;
        recordSkippedRun(job, workflowRunId, `skipped: ${reason}`);
        rollUpWorkflowProgress(workflowRunId, `${settled}/${total} stages (${job} skipped)`);
        log(`⊘ ${job} skipped — ${reason}`, 'warn');
      },
    });

    // Cancelled mid-run — stop cycling (the in-flight stage was already killed
    // and drained by executeDag) and fall through to the cancelled finalisation.
    if (controller.signal.aborted) break;

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
      await sleep(def.cycleSleepMs ?? 0);
    }
  }
  } finally {
    activeWorkflowRuns.delete(workflowRunId);
  }

  // A cancelled run is recorded 'cancelled' regardless of the members' tally —
  // the abort is the authoritative outcome (in-flight members were killed and
  // settled 'cancelled'; not-yet-started stages never spawned).
  const statuses = [...lastStatuses.values()];
  const status: WorkflowRunStatus = controller.signal.aborted
    ? 'cancelled'
    : statuses.length === 0 ? 'failed'
    : statuses.every((s) => s === 'success') ? 'success'
    : statuses.some((s) => s === 'success') ? 'partial'
    : 'failed';
  finishWorkflowRun(workflowRunId, status);
  log(status === 'cancelled' ? `Workflow "${def.name}" cancelled` : `Workflow "${def.name}" finished: ${status}`);
  await notifyWorkflow(def.name, workflowRunId, status, log);
  return { workflowRunId };
}
