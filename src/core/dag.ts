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
 * A validation gate on a DAG edge: the upstream `producer` emits artifact `key`
 * and the downstream `consumer` requires it, so the contract for `key` is checked
 * at that boundary before the consumer runs.
 */
export interface Gate {
  key: string;
  producer: string;
  consumer: string;
  /**
   * Human-readable summary of what the gate's contracts ASSERT (the producer's
   * `produces[key].description` and/or the consumer's `consumes[key].description`).
   * Not set by `deriveGates` (which only sees keys) — enriched by the caller that
   * has the job definitions (the API) so the detail view can explain the gate.
   */
  description?: string;
}

/**
 * The stable, leading portion of the error a gate violation records on its
 * (failed, never-spawned) consumer run — `recordGateFailure` writes this prefix
 * followed by the per-drift violations. Centralised here so the executor (which
 * WRITES the failure) and the API (which READS member runs back to classify each
 * gate's state) agree on one format. Changing it is a breaking change to both.
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
}

/**
 * Classify each gate against a workflow run's member runs — pure, so it's the
 * same logic on the API and in tests. `runs` must be in chronological order (the
 * DB returns them `ORDER BY started_at`), so the consumer's LAST run reflects the
 * current state. A gate is:
 *  - **failed** if its consumer's latest run is a gate-failure for THIS gate (its
 *    error starts with `gateFailurePrefix`); links to that run's logs.
 *  - **passed** if the consumer actually executed — the consumer only spawns once
 *    all its inbound gates passed.
 *  - **pending** otherwise: the consumer hasn't crossed this boundary — not yet
 *    run, skipped by an upstream failure, or blocked by a DIFFERENT inbound gate
 *    (its latest run is a gate failure that isn't this gate's).
 */
export function classifyGates(gates: Gate[], runs: GateRunRef[]): GateStatus[] {
  return gates.map((gate) => {
    const consumerRuns = runs.filter((r) => r.job_name === gate.consumer);
    const latest = consumerRuns[consumerRuns.length - 1];
    if (!latest) return { ...gate, state: 'pending' };
    const err = latest.error ?? '';
    if (latest.status === 'failed' && err.startsWith(gateFailurePrefix(gate))) {
      return { ...gate, state: 'failed', failureRunId: latest.id };
    }
    if (latest.status === 'skipped' || err.startsWith('Gate violation')) {
      return { ...gate, state: 'pending' };
    }
    return { ...gate, state: 'passed' };
  });
}

/**
 * Derive the typed-artifact gates implied by a DAG plus each member's declared
 * produced/consumed artifact keys. For every edge (producer → consumer), each
 * key the producer PRODUCES and the consumer CONSUMES becomes a gate to enforce
 * at that boundary. Pure: a consumed key with no producing upstream is an
 * external input, not a stage boundary, so it yields no gate. Returned in
 * consumer-then-producer declaration order for stable logging/tests.
 */
export function deriveGates(
  dag: Dag,
  produces: Map<string, string[]>,
  consumes: Map<string, string[]>,
): Gate[] {
  const gates: Gate[] = [];
  for (const consumer of dag.nodes) {
    const wants = consumes.get(consumer);
    if (!wants || wants.length === 0) continue;
    const wantSet = new Set(wants);
    for (const producer of dag.dependencies.get(consumer)!) {
      for (const key of produces.get(producer) ?? []) {
        if (wantSet.has(key)) gates.push({ key, producer, consumer });
      }
    }
  }
  return gates;
}

export interface DagExecHooks {
  /** Run one job and resolve with its terminal status. */
  runOne: (job: string) => Promise<RunStatus>;
  concurrency?: number;
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
        const failedDep = dag.dependencies.get(job)!.find((d) => status.get(d) !== 'success');
        if (failedDep) {
          await settle(job, 'skipped', true, `upstream ${failedDep} did not succeed`);
          continue;
        }
        if (inflight.size >= concurrency) continue; // no free slot; pick up next round
        hooks.onStart?.(job);
        const p = hooks
          .runOne(job)
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
