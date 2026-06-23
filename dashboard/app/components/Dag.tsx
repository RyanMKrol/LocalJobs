'use client';

import { Fragment } from 'react';
import type { GateStatus, StructuralGate, WorkflowMember } from '../lib/api';
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
 * A validation gate normalised for rendering, independent of whether it came from a
 * run (`GateStatus`) or the structural definition view (`StructuralGate`). `state`
 * gains a `structural` variant for the definition view (no run state). `href` is the
 * gate's detail page when one can be linked (always for run gates; for structural
 * gates only when a `workflowName` is given), else undefined → a non-interactive marker.
 */
type GateState = 'passed' | 'failed' | 'pending' | 'structural';
interface RenderGate {
  key: string;
  producer: string;
  consumer: string;
  description?: string | null;
  state: GateState;
  href?: string;
}

function gateTitle(g: RenderGate): string {
  const base = `${g.producer} → ${g.consumer} (artifact "${g.key}")`;
  const desc = g.description ? ` — ${g.description}` : '';
  return g.state === 'structural'
    ? `gate: ${base}${desc}`
    : `gate ${g.state}: ${base}${desc} — click for detail`;
}

/** Render a set of validation gates as compact key-pill marks. */
function GateMarks({ gates }: { gates: RenderGate[] }) {
  if (gates.length === 0) return null;
  return (
    <div className="dag-gates gs-key">
      {gates.map((g) => {
        const cls = `dag-gate gs-key ${g.state}`;
        const title = gateTitle(g);
        return g.href ? (
          <a key={`${g.producer}:${g.key}`} href={g.href} className={cls} title={title}>{g.key}</a>
        ) : (
          <span key={`${g.producer}:${g.key}`} className={cls} title={title}>{g.key}</span>
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
  workflowName,
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
  /** Workflow name; when provided, structural gate chips link to that workflow's
   *  run-AGNOSTIC, definition-level gate detail (NOT any specific run). */
  workflowName?: string;
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

  // Normalise either gate source into the render shape, attaching the detail-page
  // href. Run gates link to THIS run's actual-vs-expected gate page; structural
  // (definition-view) gates link to the run-AGNOSTIC, definition-level gate detail
  // — so a definition-view chip behaves like a job node there (a read-only view of
  // the gate itself), never jumping into one arbitrary run.
  const runGateHref = (runId: string, g: { producer: string; key: string }) =>
    `/workflow-runs/${runId}/gates/${encodeURIComponent(g.producer)}/${encodeURIComponent(g.key)}`;
  const defGateHref = (name: string, g: { producer: string; key: string }) =>
    `/workflows/${encodeURIComponent(name)}/gates/${encodeURIComponent(g.producer)}/${encodeURIComponent(g.key)}`;
  const normRun = (g: GateStatus): RenderGate => ({
    key: g.key, producer: g.producer, consumer: g.consumer, description: g.description,
    state: g.state, href: workflowRunId ? runGateHref(workflowRunId, g) : undefined,
  });
  const normStruct = (g: StructuralGate): RenderGate => ({
    key: g.key, producer: g.producer, consumer: g.consumer, description: g.description,
    state: 'structural', href: workflowName ? defGateHref(workflowName, g) : undefined,
  });
  const arrowGates = (i: number): RenderGate[] =>
    workflowRunId ? (runGates.onArrow.get(i) ?? []).map(normRun) : (structGates.onArrow.get(i) ?? []).map(normStruct);
  const nodeGates = (job: string): RenderGate[] =>
    workflowRunId ? (runGates.onConsumer.get(job) ?? []).map(normRun) : (structGates.onConsumer.get(job) ?? []).map(normStruct);

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
                  {/* Fallback marks for non-adjacent edges that can't sit on an arrow. */}
                  <GateMarks gates={nodeGates(job)} />
                </div>
              );
            })}
          </div>
          {i < waves.length - 1 && (
            <div className="dag-arrow">
              <span className="dag-arrow-glyph">→</span>
              <GateMarks gates={arrowGates(i)} />
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

