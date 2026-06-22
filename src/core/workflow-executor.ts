import { getJobDefinition } from '../jobs/registry.js';
import {
  addWorkflowLog,
  createWorkflowRun,
  finishWorkflowRun,
  hasActiveWorkflowRun,
  workflowRetryableCount,
  recordGateFailure,
  recordSkippedRun,
  rollUpWorkflowProgress,
} from '../db/store.js';
import { type Dag, type Gate, buildDag, deriveGates, executeDag, gateFailurePrefix } from './dag.js';
import { runJobForWorkflow } from './executor.js';
import { notifyWorkflow, notifyStage } from './notifier.js';
import type { LogLevel, WorkflowDefinition, WorkflowRunStatus, RunStatus } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
 * Run a workflow: execute its DAG (one topological pass), optionally repeating in
 * cycles until no retryable work remains. The daemon owns this (it's the DB
 * writer). Member job runs link to the workflow run; the workflow emits per-stage
 * + aggregate notifications and writes framework logs.
 */
export async function runWorkflow(def: WorkflowDefinition, trigger: 'schedule' | 'manual'): Promise<WorkflowRunResult> {
  if (hasActiveWorkflowRun(def.name)) {
    return { workflowRunId: null, skipped: true, reason: 'already running' };
  }

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

  const workflowRunId = createWorkflowRun(def.name, trigger);
  const controller = new AbortController();
  activeWorkflowRuns.set(workflowRunId, controller);
  const log = (m: string, level: LogLevel = 'info') => addWorkflowLog(workflowRunId, m, level);
  const total = dag.nodes.length;
  const memberNames = def.jobs.map((j) => j.job);
  const minAttempts = def.minAttempts ?? 4;
  const maxCycles = def.repeatUntilStable ? Math.max(1, def.maxCycles ?? 1) : 1;

  log(`Workflow "${def.name}" started · ${total} job(s) · ${gates.length} gate(s) · trigger=${trigger}${def.repeatUntilStable ? ` · repeatUntilStable (maxCycles=${maxCycles})` : ''}`);

  let lastStatuses = new Map<string, RunStatus>();
  try {
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    if (def.repeatUntilStable) log(`──── cycle ${cycle}/${maxCycles} ────`);
    let settled = 0;

    lastStatuses = await executeDag(dag, {
      concurrency: def.maxConcurrency ?? 1,
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
        await notifyStage(def.name, workflowRunId, job, s, log);
      },
      onSkip: async (job, reason) => {
        settled++;
        recordSkippedRun(job, workflowRunId, `skipped: ${reason}`);
        rollUpWorkflowProgress(workflowRunId, `${settled}/${total} stages (${job} skipped)`);
        log(`⊘ ${job} skipped — ${reason}`, 'warn');
        await notifyStage(def.name, workflowRunId, job, 'skipped', log);
      },
    });

    // Cancelled mid-run — stop cycling (the in-flight stage was already killed
    // and drained by executeDag) and fall through to the cancelled finalisation.
    if (controller.signal.aborted) break;

    if (!def.repeatUntilStable) break;
    const retryable = workflowRetryableCount(memberNames, minAttempts);
    log(`cycle ${cycle} complete · retryable work left = ${retryable}`);
    if (retryable === 0) {
      log('Stable — no retryable work remaining.');
      break;
    }
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
    : statuses.length === 0 ? 'failed' : statuses.every((s) => s === 'success') ? 'success' : 'partial';
  finishWorkflowRun(workflowRunId, status);
  log(status === 'cancelled' ? `Workflow "${def.name}" cancelled` : `Workflow "${def.name}" finished: ${status}`);
  await notifyWorkflow(def.name, workflowRunId, status, log);
  return { workflowRunId };
}
