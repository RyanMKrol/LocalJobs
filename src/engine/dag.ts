import type { WorkflowJobRef, RunStatus } from './types.js';

/** Thrown when a workflow's `jobs` cannot form a valid DAG. */
export class DagError extends Error {}

export interface Dag {
  /** Member job names in declaration order. */
  nodes: string[];
  /** Topologically ordered waves; jobs within a wave have no ordering between them. */
  waves: string[][];
  /** job → its direct upstream dependencies. */
  dependencies: Map<string, string[]>;
  /** job → its direct downstream dependents. */
  dependents: Map<string, string[]>;
}

/**
 * Build a DAG from a workflow's job refs. Validates: no duplicate members, every
 * `dependsOn` names a member, no self-edge, and the graph is acyclic. Returns
 * execution **waves** (Kahn's algorithm) — a job lands one wave after its latest
 * dependency, so processing waves left-to-right always respects all edges.
 *
 * NOTE: this is pure graph logic over the refs given. Checking that each `job`
 * resolves to a real *.job.ts definition is the registry's responsibility.
 */
export function buildDag(refs: WorkflowJobRef[]): Dag {
  const nodes = refs.map((r) => r.job);

  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n)) throw new DagError(`duplicate member job "${n}"`);
    seen.add(n);
  }

  const dependencies = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    dependencies.set(n, []);
    dependents.set(n, []);
  }
  for (const r of refs) {
    for (const dep of r.dependsOn ?? []) {
      if (dep === r.job) throw new DagError(`job "${r.job}" depends on itself`);
      if (!seen.has(dep)) throw new DagError(`job "${r.job}" depends on "${dep}", which is not a member of this workflow`);
      dependencies.get(r.job)!.push(dep);
      dependents.get(dep)!.push(r.job);
    }
  }

  // Kahn's algorithm, emitting waves.
  const indegree = new Map<string, number>();
  for (const n of nodes) indegree.set(n, dependencies.get(n)!.length);

  const waves: string[][] = [];
  let remaining = nodes.length;
  let ready = nodes.filter((n) => indegree.get(n) === 0);
  while (ready.length > 0) {
    waves.push(ready);
    remaining -= ready.length;
    const next: string[] = [];
    for (const n of ready) {
      for (const d of dependents.get(n)!) {
        const deg = indegree.get(d)! - 1;
        indegree.set(d, deg);
        if (deg === 0) next.push(d);
      }
    }
    ready = next;
  }

  if (remaining > 0) {
    const cyclic = nodes.filter((n) => (indegree.get(n) ?? 0) > 0);
    throw new DagError(`cycle detected involving: ${cyclic.join(', ')}`);
  }

  return { nodes, waves, dependencies, dependents };
}

/**
 * A gate on a DAG edge: the upstream `producer` commits the artifact `key` and
 * the downstream `consumer` takes it as an input, so that artifact is resolved
 * and checked at the boundary before the consumer runs.
 */
export interface Gate {
  key: string;
  producer: string;
  consumer: string;
  /** What the artifact is, in a sentence (the artifact type's own description). */
  description?: string;
}

/**
 * The stable, leading portion of the error a gate violation records on its
 * (failed, never-spawned) consumer run — `recordGateFailure` writes this prefix
 * followed by the reason each input could not be resolved. Centralised here so
 * the executor (which WRITES the failure) and the API (which READS member runs
 * back to classify each gate's state) agree on one format. Changing it is a
 * breaking change to both.
 */
export function gateFailurePrefix(gate: Gate): string {
  return `Gate violation [${gate.producer} → ${gate.consumer}] artifact "${gate.key}"`;
}

/** A gate's outcome within one workflow run, derived from member runs. */
export type GateState = 'passed' | 'failed' | 'pending';

export interface GateStatus extends Gate {
  state: GateState;
  /** When `failed`, the id of the gate-failure run to link to its logs. */
  failureRunId?: string;
}

/** Minimal shape of a member run needed to classify gates (a subset of a DB run row). */
export interface GateRunRef {
  id: string;
  job_name: string;
  status: string;
  error: string | null;
  /** Engine-v2 machine-readable reason (see `OutcomeReason`); absent on old rows. */
  outcome_reason?: string | null;
}

/** Outcome reasons meaning the consumer never actually crossed its gates and ran. */
const NEVER_RAN_REASONS = new Set(['upstream-skipped', 'overlap', 'not-started-cancelled', 'orphaned']);

/**
 * Classify each gate against a workflow run's member runs — pure, so it's the
 * same logic on the API and in tests. `runs` must be in chronological order (the
 * DB returns them `ORDER BY started_at`), so the consumer's LAST run reflects the
 * current state. A gate is:
 *  - **failed** if its consumer's latest run is a gate-failure naming THIS gate
 *    (its error contains `gateFailurePrefix`); links to that run's logs.
 *  - **passed** if the consumer actually executed — the consumer only spawns once
 *    all its inbound gates passed. A consumer that ran and was then marked a noop
 *    or stalled (status `skipped`, `outcome_reason` noop/stalled) DID run, so its
 *    gates passed; reading its `skipped` status as "never ran" used to show a gate
 *    that had passed as pending.
 *  - **pending** otherwise: the consumer hasn't crossed this boundary — not yet
 *    run, skipped by an upstream failure, never started (cancel / restart), or
 *    blocked by a DIFFERENT inbound gate (its latest run is a gate failure that
 *    isn't this gate's).
 *
 * Rows written before `outcome_reason` existed fall back to the old rule
 * (`skipped` = never ran).
 */
export function classifyGates(gates: Gate[], runs: GateRunRef[]): GateStatus[] {
  return gates.map((gate) => {
    const consumerRuns = runs.filter((r) => r.job_name === gate.consumer);
    const latest = consumerRuns[consumerRuns.length - 1];
    if (!latest) return { ...gate, state: 'pending' };
    const err = latest.error ?? '';
    // `includes`, not `startsWith`: every inbound gate is evaluated, so one
    // gate-failure row can carry SEVERAL gates' violations (joined), and each of
    // those gates must read as failed, not just the one that happens to lead.
    if (latest.status === 'failed' && err.includes(gateFailurePrefix(gate))) {
      return { ...gate, state: 'failed', failureRunId: latest.id };
    }
    if (err.startsWith('Gate violation')) return { ...gate, state: 'pending' };
    const reason = latest.outcome_reason ?? null;
    const neverRan = reason ? NEVER_RAN_REASONS.has(reason) : latest.status === 'skipped';
    return { ...gate, state: neverRan ? 'pending' : 'passed' };
  });
}

export interface DagExecHooks {
  /** Run one job and resolve with its terminal status. */
  runOne: (job: string) => Promise<RunStatus>;
  concurrency?: number;
  /** Called ONCE per job, the first time all its dependencies have settled
   *  successfully (it is now waiting only for a free concurrency slot). Lets the
   *  caller timestamp "became ready" so queue-wait time is measurable. */
  onReady?: (job: string) => void;
  onStart?: (job: string) => void;
  onSettle?: (job: string, status: RunStatus) => void | Promise<void>;
  onSkip?: (job: string, reason: string) => void | Promise<void>;
  /**
   * Cancellation. Once aborted, the loop stops launching NEW stages (not-yet-
   * started members simply never spawn) and only drains the already in-flight
   * members — whose `runOne` is itself responsible for hard-killing its child on
   * the same signal. So an aborted run settles cleanly: in-flight work is killed
   * and reaped, nothing new starts.
   */
  signal?: AbortSignal;
}

/**
 * Execute a DAG: launch jobs whose dependencies have all SUCCEEDED, up to
 * `concurrency` at a time; a job any of whose dependencies didn't succeed is
 * SKIPPED, and that skip cascades to its own dependents. Pure orchestration —
 * the job-runner and side effects are injected, so it's deterministically
 * testable. Resolves with the terminal status of every node.
 *
 * If `hooks.signal` aborts mid-run, no further stages are launched; the loop
 * waits out the in-flight members (each kills its own child via the signal) and
 * returns. Not-yet-started members are left absent from the status map.
 */
export async function executeDag(dag: Dag, hooks: DagExecHooks): Promise<Map<string, RunStatus>> {
  const concurrency = Math.max(1, hooks.concurrency ?? 1);
  const status = new Map<string, RunStatus>();
  const remaining = new Set(dag.nodes);
  const indegree = new Map<string, number>(dag.nodes.map((n) => [n, dag.dependencies.get(n)!.length]));
  const inflight = new Map<string, Promise<void>>();
  const readied = new Set<string>();

  const settle = async (job: string, s: RunStatus, skipped: boolean, reason?: string) => {
    status.set(job, s);
    remaining.delete(job);
    for (const dep of dag.dependents.get(job)!) indegree.set(dep, indegree.get(dep)! - 1);
    if (skipped) await hooks.onSkip?.(job, reason!);
    else await hooks.onSettle?.(job, s);
  };

  while (remaining.size > 0) {
    // Once cancelled, stop launching new stages — only drain what's in flight.
    if (!hooks.signal?.aborted) {
      const ready = [...remaining].filter((n) => indegree.get(n) === 0 && !inflight.has(n));
      for (const job of ready) {
        // Name EVERY dependency that did not succeed (with its status), not just
        // the first: on a fan-in the answer to "why was this skipped" is often
        // more than one branch.
        const failedDeps = dag.dependencies.get(job)!.filter((d) => status.get(d) !== 'success');
        if (failedDeps.length > 0) {
          const detail = failedDeps.length === 1
            ? `upstream ${failedDeps[0]} did not succeed (${status.get(failedDeps[0])})`
            : `${failedDeps.length} upstream stages did not succeed: ${failedDeps.map((d) => `${d} (${status.get(d)})`).join(', ')}`;
          await settle(job, 'skipped', true, detail);
          continue;
        }
        if (!readied.has(job)) {
          readied.add(job);
          hooks.onReady?.(job);
        }
        if (inflight.size >= concurrency) continue; // no free slot; pick up next round
        hooks.onStart?.(job);
        const p = hooks
          .runOne(job)
          // A rejecting runOne (an unexpected throw, not a resolved 'failed') must
          // not poison the whole executeDag promise — that would stop every other
          // independent stage from running and reject the caller outright. Treat
          // it identically to a resolved 'failed': map the rejection to 'failed'
          // BEFORE settle() so its dependents cascade-skip and executeDag resolves
          // normally. Scoped to runOne only — a genuine error from settle()/onSettle
          // itself (e.g. a DB write failure) is left to propagate, as defence in
          // depth the caller (runWorkflowInner) handles.
          .catch((): RunStatus => 'failed')
          .then((s) => settle(job, s, false))
          .finally(() => inflight.delete(job));
        inflight.set(job, p);
      }
    }

    if (inflight.size > 0) {
      await Promise.race(inflight.values());
    } else if (hooks.signal?.aborted) {
      break; // cancelled and nothing left in flight — stop without launching more
    } else if (remaining.size > 0 && ![...remaining].some((n) => indegree.get(n) === 0)) {
      break; // safety: nothing runnable and nothing in flight (impossible for a valid DAG)
    }
  }

  return status;
}
