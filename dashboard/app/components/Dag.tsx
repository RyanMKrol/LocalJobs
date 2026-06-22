'use client';

import { Fragment } from 'react';
import type { BacklogTask, GateStatus, StructuralGate, WorkflowMember } from '../lib/api';
import { statusLabel } from '../ui';

/** Topologically order members into waves (jobs in a wave have no ordering). */
function computeWaves(members: WorkflowMember[]): string[][] {
  const names = members.map((m) => m.job_name);
  const indeg = new Map(members.map((m) => [m.job_name, m.depends_on.length]));
  const dependents = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const m of members) for (const d of m.depends_on) dependents.get(d)?.push(m.job_name);

  const waves: string[][] = [];
  const seen = new Set<string>();
  let ready = names.filter((n) => (indeg.get(n) ?? 0) === 0);
  while (ready.length) {
    waves.push(ready);
    ready.forEach((n) => seen.add(n));
    const next: string[] = [];
    for (const n of ready) {
      for (const dep of dependents.get(n) ?? []) {
        indeg.set(dep, (indeg.get(dep) ?? 0) - 1);
        if (indeg.get(dep) === 0) next.push(dep);
      }
    }
    ready = next;
  }
  for (const n of names) if (!seen.has(n)) waves.push([n]); // cycle fallback (shouldn't happen)
  return waves;
}


/**
 * Render structural (no-run-state) gate chips for the workflow definition view.
 * Each chip marks that a validation gate exists on this edge. When `lastRunId` is
 * provided the chip links to that run's gate detail page so the contract can be
 * inspected; otherwise it renders as a non-interactive marker.
 */
function StructuralGateChips({ gates, lastRunId }: { gates: StructuralGate[]; lastRunId?: string }) {
  if (gates.length === 0) return null;
  return (
    <div className="dag-gates">
      {gates.map((g) => {
        const label = `⛒ ${g.producer} · ${g.key}`;
        const title = g.description
          ? `gate: ${g.producer} → ${g.consumer} (artifact "${g.key}") — ${g.description}`
          : `gate: ${g.producer} → ${g.consumer} (artifact "${g.key}")`;
        if (lastRunId) {
          const href = `/workflow-runs/${lastRunId}/gates/${encodeURIComponent(g.producer)}/${encodeURIComponent(g.key)}`;
          return (
            <a key={`${g.producer}:${g.key}`} href={href} className="dag-gate structural" title={title}>
              {label}
            </a>
          );
        }
        return (
          <span key={`${g.producer}:${g.key}`} className="dag-gate structural" title={title}>
            {label}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Render a set of validation gates as small chips, each naming its producer +
 * artifact key and coloured by state. Used both on the inter-wave arrow (the gates
 * guarding that edge) and as the consumer-node fallback for non-adjacent edges.
 * EVERY chip (passed, failed, or pending) links to that gate's dedicated detail
 * page, so any gate can be inspected — not just failures. `workflowRunId` is
 * required to build the URL.
 */
function GateChips({ gates, workflowRunId }: { gates: GateStatus[]; workflowRunId: string }) {
  if (gates.length === 0) return null;
  return (
    <div className="dag-gates">
      {gates.map((g) => {
        const label = `⛒ ${g.producer} · ${g.key}`;
        const title = `gate ${g.state}: ${g.producer} → ${g.consumer} (artifact "${g.key}") — click for detail`;
        const href = `/workflow-runs/${workflowRunId}/gates/${encodeURIComponent(g.producer)}/${encodeURIComponent(g.key)}`;
        return (
          <a key={`${g.producer}:${g.key}`} href={href} className={`dag-gate ${g.state}`} title={title}>
            {label}
          </a>
        );
      })}
    </div>
  );
}

/**
 * Render a workflow DAG as left-to-right waves of status-coloured nodes. Pass
 * `statusByJob` to colour each node by a run's member status, and `runIdByJob`
 * to make nodes link into that member's run logs. Pass `gates` (run view only) to
 * mark each producer→consumer validation gate ON THE ARROW between the two jobs it
 * guards — a failed gate is red and links to its failure logs. Pass
 * `structuralGates` (definition view) to show those gate markers without run state.
 */
export function Dag({
  members,
  statusByJob,
  runIdByJob,
  gates,
  structuralGates,
  lastRunId,
  from,
  workflowRunId,
}: {
  members: WorkflowMember[];
  statusByJob?: Record<string, string>;
  runIdByJob?: Record<string, string>;
  /** Validation-gate states for THIS run; omit on the structure-only view. */
  gates?: GateStatus[];
  /** Structural gates for the definition view (no run state). */
  structuralGates?: StructuralGate[];
  /** Last workflow run id; when provided, structural gate chips link to that run's gate detail. */
  lastRunId?: string;
  /** Path of the page rendering this DAG, threaded onto node links as `?from=`
   *  so the job/run page can send the back-link to where you actually came from. */
  from?: string;
  /** Workflow run id, required when `gates` is provided to build gate-detail URLs. */
  workflowRunId?: string;
}) {
  const waves = computeWaves(members);
  // Wave index of each job, so a gate's (producer, consumer) can be placed on the
  // arrow that bridges them.
  const waveOf = new Map<string, number>();
  waves.forEach((wave, i) => wave.forEach((job) => waveOf.set(job, i)));

  // A gate guards a producer→consumer edge, so its chip belongs ON the arrow
  // between those two waves — the arrow rendered after the PRODUCER's wave (index
  // i bridges wave i → i+1). For the strictly-linear example workflows the
  // producer is always the wave immediately before the consumer, so the gate sits
  // on that inter-wave arrow. For any non-adjacent edge (producer more than one
  // wave upstream) we DON'T drop the chip — we fall back to rendering it under the
  // consumer node, keyed by consumer, rather than mis-placing it on a wrong arrow.
  const partition = <T extends { producer: string; consumer: string }>(items: T[]) => {
    const onArrow = new Map<number, T[]>(); // arrow index (= producer wave) → gates
    const onConsumer = new Map<string, T[]>(); // fallback for non-adjacent edges
    for (const g of items) {
      const pi = waveOf.get(g.producer);
      const ci = waveOf.get(g.consumer);
      if (pi != null && ci === pi + 1) (onArrow.get(pi) ?? onArrow.set(pi, []).get(pi)!).push(g);
      else (onConsumer.get(g.consumer) ?? onConsumer.set(g.consumer, []).get(g.consumer)!).push(g);
    }
    return { onArrow, onConsumer };
  };
  const runGates = partition(gates ?? []);
  const structGates = partition(structuralGates ?? []);

  return (
    <div className="dag">
      {waves.map((wave, i) => (
        <Fragment key={i}>
          <div className="dag-wave">
            {wave.map((job) => {
              const status = statusByJob?.[job] ?? 'pending';
              const runId = runIdByJob?.[job];
              const node = (
                <div className={`dag-node ${status}`}>
                  <div className="dag-node-name">{job}</div>
                  {statusByJob && <div className="dag-node-status">{statusLabel(status)}</div>}
                </div>
              );
              const href = (runId ? `/runs/${runId}` : `/jobs/${job}`) + (from ? `?from=${encodeURIComponent(from)}` : '');
              return (
                <div key={job}>
                  <a href={href} style={{ textDecoration: 'none' }}>{node}</a>
                  {/* Fallback chips for non-adjacent edges that can't sit on an arrow. */}
                  {workflowRunId && <GateChips gates={runGates.onConsumer.get(job) ?? []} workflowRunId={workflowRunId} />}
                  {!workflowRunId && <StructuralGateChips gates={structGates.onConsumer.get(job) ?? []} lastRunId={lastRunId} />}
                </div>
              );
            })}
          </div>
          {i < waves.length - 1 && (
            <div className="dag-arrow">
              <span className="dag-arrow-glyph">→</span>
              {workflowRunId && <GateChips gates={runGates.onArrow.get(i) ?? []} workflowRunId={workflowRunId} />}
              {!workflowRunId && <StructuralGateChips gates={structGates.onArrow.get(i) ?? []} lastRunId={lastRunId} />}
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

/** Topologically order backlog tasks into waves by dependsOn. */
function computeBacklogWaves(tasks: BacklogTask[]): string[][] {
  const ids = tasks.map((t) => t.id);
  const indeg = new Map(tasks.map((t) => [t.id, t.dependsOn.length]));
  const dependents = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const t of tasks) {
    for (const dep of t.dependsOn) dependents.get(dep)?.push(t.id);
  }
  const waves: string[][] = [];
  const seen = new Set<string>();
  let ready = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  while (ready.length) {
    waves.push(ready);
    ready.forEach((id) => seen.add(id));
    const next: string[] = [];
    for (const id of ready) {
      for (const dep of dependents.get(id) ?? []) {
        indeg.set(dep, (indeg.get(dep) ?? 0) - 1);
        if (indeg.get(dep) === 0) next.push(dep);
      }
    }
    ready = next;
  }
  for (const id of ids) if (!seen.has(id)) waves.push([id]); // cycle fallback
  return waves;
}

/**
 * Render the backlog task graph as left-to-right dependency waves. Each node is a
 * styled card showing the task id, its title, and a status badge coloured by state
 * (done · needs human · pending). Click a node to select it. There is deliberately
 * NO "next" concept on this view (T076).
 */
export function BacklogDag({
  tasks,
  selectedId,
  onSelect,
}: {
  tasks: BacklogTask[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const waves = computeBacklogWaves(tasks);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  return (
    <div className="dag backlog-dag-scroll">
      {waves.map((wave, i) => (
        <Fragment key={i}>
          <div className="dag-wave">
            {wave.map((id) => {
              const t = taskById.get(id);
              const statusClass = t?.status === 'done' ? 'done' : t?.gate != null ? 'needs-human' : '';
              const statusWord = t?.status === 'done' ? 'done' : t?.gate != null ? 'needs human' : 'pending';
              const isSelected = id === selectedId;
              return (
                <button
                  key={id}
                  onClick={() => onSelect(isSelected ? null : id)}
                  title={t?.title ?? id}
                  className={`dag-node backlog-node ${statusClass}${isSelected ? ' selected' : ''}`}
                  style={{ all: 'unset', cursor: 'pointer', display: 'block', textAlign: 'left' }}
                >
                  <div className="backlog-node-head">
                    <span className="backlog-node-id">{id}</span>
                    <span className={`backlog-node-badge ${statusClass}`}>{statusWord}</span>
                  </div>
                  <div className="backlog-node-title">{t?.title ?? id}</div>
                </button>
              );
            })}
          </div>
          {i < waves.length - 1 && (
            <div className="dag-arrow">
              <span className="dag-arrow-glyph">→</span>
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}
