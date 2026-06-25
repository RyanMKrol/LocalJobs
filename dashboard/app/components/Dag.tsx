'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
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

interface SkipEdgeDraw {
  d: string;
  midX: number;
  midY: number;
  gates: RenderGate[];
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
  const containerRef = useRef<HTMLDivElement>(null);
  const [skipDrawn, setSkipDrawn] = useState<SkipEdgeDraw[]>([]);
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });

  const waves = computeWaves(members);
  // Wave index of each job, so a gate's (producer, consumer) can be placed on the
  // arrow that bridges them.
  const waveOf = new Map<string, number>();
  waves.forEach((wave, i) => wave.forEach((job) => waveOf.set(job, i)));

  // A gate guards a producer→consumer edge, so its chip belongs ON the arrow
  // between those two waves — the arrow rendered after the PRODUCER's wave (index
  // i bridges wave i → i+1). For the strictly-linear example workflows the
  // producer is always the wave immediately before the consumer, so the gate sits
  // on that inter-wave arrow. Non-adjacent edges (producer more than one wave
  // upstream) are drawn as skip-wave SVG connectors (see below) with the gate
  // chip placed along the path.
  const partition = <T extends { producer: string; consumer: string }>(items: T[]) => {
    const onArrow = new Map<number, T[]>(); // arrow index (= producer wave) → gates
    const onConsumer = new Map<string, T[]>(); // fallback for non-adjacent edges (will be drawn on SVG path)
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
  // Adjacent-edge gates under consumer nodes are no longer used (drawn on SVG path instead),
  // but this is kept for type-safety; skip-edge gates are filtered out below.
  const consumerGates = (job: string): RenderGate[] =>
    workflowRunId ? (runGates.onConsumer.get(job) ?? []).map(normRun) : (structGates.onConsumer.get(job) ?? []).map(normStruct);

  // Collect all skip-wave edges (non-adjacent producer→consumer). For each we
  // draw an SVG connector path instead of a fallback chip under the consumer.
  const skipEdges = members.flatMap((m) =>
    m.depends_on
      .filter((dep) => {
        const pi = waveOf.get(dep);
        const ci = waveOf.get(m.job_name);
        return pi != null && ci != null && (ci as number) > (pi as number) + 1;
      })
      .map((dep) => ({
        producer: dep,
        consumer: m.job_name,
        // Gates for this specific producer→consumer pair come from onConsumer
        // (they were partitioned there because the edge is non-adjacent).
        gates: consumerGates(m.job_name).filter((g) => g.producer === dep),
      }))
  );
  // Set of skip-edge consumer gates that will be drawn on the SVG path — exclude
  // them from the per-node fallback chip rendering so they don't appear twice.
  const skipGateKey = (producer: string, consumer: string) => `${producer}\x00${consumer}`;
  const skipEdgeSet = new Set(skipEdges.map((e) => skipGateKey(e.producer, e.consumer)));
  const nodeGates = (job: string): RenderGate[] =>
    consumerGates(job).filter((g) => !skipEdgeSet.has(skipGateKey(g.producer, job)));

  // After each render, measure node positions and compute SVG paths for skip edges.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const compute = () => {
      const cRect = container.getBoundingClientRect();
      const w = cRect.width;
      const h = cRect.height;

      if (skipEdges.length === 0) {
        setSkipDrawn([]);
        setSvgSize({ w, h });
        return;
      }

      // Detect layout orientation: on phone the dag is flex-column so the y-span
      // of a multi-wave workflow dominates; on desktop it's flex-row (x-span dominates).
      // We determine this by checking whether the container's flex-direction is column.
      const vertical = getComputedStyle(container).flexDirection === 'column';

      const drawn: SkipEdgeDraw[] = [];
      for (const { producer, consumer, gates: edgeGates } of skipEdges) {
        // Find the rendered node elements by data attribute.
        const pEl = container.querySelector<HTMLElement>(
          `[data-dag-job="${producer.replace(/"/g, '\\"')}"] .dag-node`
        );
        const cEl = container.querySelector<HTMLElement>(
          `[data-dag-job="${consumer.replace(/"/g, '\\"')}"] .dag-node`
        );
        if (!pEl || !cEl) continue;

        const pRect = pEl.getBoundingClientRect();
        const cRect2 = cEl.getBoundingClientRect();

        let x1: number, y1: number, x2: number, y2: number, d: string, midX: number, midY: number;

        if (!vertical) {
          // Desktop (horizontal): producer right-center → consumer left-center.
          // Route BELOW intermediate waves so the connector is visually distinct
          // from the adjacent-wave arrows between them.
          x1 = pRect.right - cRect.left;
          y1 = pRect.top + pRect.height / 2 - cRect.top;
          x2 = cRect2.left - cRect.left;
          y2 = cRect2.top + cRect2.height / 2 - cRect.top;

          // Push control points down below the deepest of the two endpoints,
          // clearing the node content. The vertical dip scales with horizontal span.
          const dip = Math.max(36, Math.abs(x2 - x1) * 0.22);
          const baseY = Math.max(y1, y2) + dip;
          const cx = (x1 + x2) / 2;
          d = `M ${x1} ${y1} C ${cx} ${baseY}, ${cx} ${baseY}, ${x2} ${y2}`;
          midX = cx;
          midY = baseY;
        } else {
          // Phone (vertical): producer bottom-center → consumer top-center.
          // Route to the RIGHT so the connector clears the node content.
          x1 = pRect.left + pRect.width / 2 - cRect.left;
          y1 = pRect.bottom - cRect.top;
          x2 = cRect2.left + cRect2.width / 2 - cRect.left;
          y2 = cRect2.top - cRect.top;

          const bulge = Math.max(36, Math.abs(y2 - y1) * 0.22);
          const rightX = Math.max(x1, x2) + bulge;
          const cy = (y1 + y2) / 2;
          d = `M ${x1} ${y1} C ${rightX} ${cy}, ${rightX} ${cy}, ${x2} ${y2}`;
          midX = rightX;
          midY = cy;
        }

        drawn.push({ d, midX, midY, gates: edgeGates });
      }

      setSkipDrawn(drawn);
      setSvgSize({ w, h });
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(container);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, gates, structuralGates, workflowRunId, workflowName]);

  return (
    <div className="dag" ref={containerRef} style={{ position: 'relative' }}>
      {/* SVG overlay for skip-wave (non-adjacent) edge connectors */}
      {svgSize.w > 0 && skipDrawn.length > 0 && (
        <svg
          aria-hidden="true"
          style={{
            position: 'absolute', top: 0, left: 0,
            width: svgSize.w, height: svgSize.h,
            pointerEvents: 'none', overflow: 'visible',
            zIndex: 0,
          }}
        >
          {skipDrawn.map((sp, idx) => (
            <path key={idx} d={sp.d} className="dag-skip-path" />
          ))}
        </svg>
      )}
      {/* Absolutely-positioned gate chips for skip edges, placed at path midpoints */}
      {skipDrawn.map((sp, idx) =>
        sp.gates.length > 0 ? (
          <div
            key={`sg-${idx}`}
            style={{
              position: 'absolute',
              left: sp.midX,
              top: sp.midY,
              transform: 'translate(-50%, -50%)',
              zIndex: 2,
              pointerEvents: 'auto',
            }}
          >
            <GateMarks gates={sp.gates} />
          </div>
        ) : null
      )}
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
                <div key={job} data-dag-job={job} style={{ position: 'relative', zIndex: 1 }}>
                  <a href={href} style={{ textDecoration: 'none' }}>{node}</a>
                  {/* Gate chips for non-skip consumer gates (none in practice; skip edges are drawn on SVG) */}
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
