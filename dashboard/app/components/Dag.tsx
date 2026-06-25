'use client';

import { useEffect, useRef, useState } from 'react';
import type { GateStatus, StructuralGate, WorkflowMember } from '../lib/api';
import { statusLabel } from '../ui';

/**
 * Compute the topological layer (column index) for each job. Layer = max(parent layers) + 1.
 * Uses Kahn's algorithm so each node's layer is finalised only after all its parents are processed.
 */
function computeLayers(members: WorkflowMember[]): Map<string, number> {
  const names = members.map((m) => m.job_name);
  const indeg = new Map(members.map((m) => [m.job_name, m.depends_on.length]));
  const dependents = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const m of members) for (const d of m.depends_on) dependents.get(d)?.push(m.job_name);

  const layer = new Map<string, number>();
  let queue = names.filter((n) => (indeg.get(n) ?? 0) === 0);
  for (const n of queue) layer.set(n, 0);

  while (queue.length) {
    const next: string[] = [];
    for (const n of queue) {
      for (const dep of dependents.get(n) ?? []) {
        indeg.set(dep, (indeg.get(dep) ?? 0) - 1);
        const newLayer = (layer.get(n) ?? 0) + 1;
        if ((layer.get(dep) ?? -1) < newLayer) layer.set(dep, newLayer);
        if (indeg.get(dep) === 0) next.push(dep);
      }
    }
    queue = next;
  }
  // Cycle fallback
  for (const n of names) if (!layer.has(n)) layer.set(n, 0);
  return layer;
}

/**
 * A validation gate normalised for rendering — works for both run gates (GateStatus)
 * and structural definition-view gates (StructuralGate). `state` gains a `structural`
 * variant for the definition view (no run state). `href` links to the gate detail page.
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

interface EdgeDraw {
  d: string;
  midX: number;
  midY: number;
  gates: RenderGate[];
}

/**
 * Render a workflow DAG with accurate dependency edges and true concurrency.
 *
 * Each node is positioned in a topological column (layer), and SVG bezier curves are
 * drawn from each producer node's right-center to each consumer node's left-center
 * (desktop) or bottom/top-center (mobile). This means only the actual `dependsOn` edges
 * are shown — a stage that is independent of others in the same column is NOT falsely
 * implied to gate them.
 *
 * Wide graphs scroll horizontally on desktop (overflow-x: auto on the container).
 * The phone layout stacks columns top-to-bottom as a single vertical column, with
 * SVG edges drawn vertically.
 *
 * Pass `statusByJob` to colour nodes by run status and `runIdByJob` to link nodes to
 * their run logs. Pass `gates` (run view) or `structuralGates` (definition view) to
 * show validation-gate marks on the connecting edges.
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
   *  run-AGNOSTIC, definition-level gate detail page. */
  workflowName?: string;
  /** Path of the page rendering this DAG, threaded onto node links as `?from=`. */
  from?: string;
  /** Workflow run id, required when `gates` is provided to build gate-detail URLs. */
  workflowRunId?: string;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [edgesDrawn, setEdgesDrawn] = useState<EdgeDraw[]>([]);
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });

  // Assign each node to a topological column (layer index)
  const layerOf = computeLayers(members);
  const numCols = members.length === 0 ? 0 : Math.max(...Array.from(layerOf.values())) + 1;
  const columns: string[][] = Array.from({ length: numCols }, () => []);
  for (const m of members) columns[layerOf.get(m.job_name) ?? 0].push(m.job_name);

  // Gate href builders
  const runGateHref = (runId: string, g: { producer: string; key: string }) =>
    `/workflow-runs/${runId}/gates/${encodeURIComponent(g.producer)}/${encodeURIComponent(g.key)}`;
  const defGateHref = (name: string, g: { producer: string; key: string }) =>
    `/workflows/${encodeURIComponent(name)}/gates/${encodeURIComponent(g.producer)}/${encodeURIComponent(g.key)}`;

  // Build an edge-keyed gate lookup: "producer\x00consumer" → RenderGate[]
  const gatesByEdge = new Map<string, RenderGate[]>();
  const push = (k: string, g: RenderGate) =>
    (gatesByEdge.get(k) ?? gatesByEdge.set(k, []).get(k)!).push(g);
  for (const g of gates ?? []) {
    push(`${g.producer}\x00${g.consumer}`, {
      key: g.key, producer: g.producer, consumer: g.consumer, description: g.description,
      state: g.state, href: workflowRunId ? runGateHref(workflowRunId, g) : undefined,
    });
  }
  for (const g of structuralGates ?? []) {
    push(`${g.producer}\x00${g.consumer}`, {
      key: g.key, producer: g.producer, consumer: g.consumer, description: g.description,
      state: 'structural', href: workflowName ? defGateHref(workflowName, g) : undefined,
    });
  }

  // After each render, measure node positions and compute SVG bezier paths for every edge.
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;

    const compute = () => {
      const iRect = inner.getBoundingClientRect();
      // Detect layout orientation: mobile stacks columns top-to-bottom (flex-column),
      // desktop flows left-to-right (flex-row).
      const vertical = getComputedStyle(inner).flexDirection === 'column';

      const drawn: EdgeDraw[] = [];
      for (const member of members) {
        for (const dep of member.depends_on) {
          const pEl = inner.querySelector<HTMLElement>(
            `[data-dag-job="${dep.replace(/"/g, '\\"')}"] .dag-node`
          );
          const cEl = inner.querySelector<HTMLElement>(
            `[data-dag-job="${member.job_name.replace(/"/g, '\\"')}"] .dag-node`
          );
          if (!pEl || !cEl) continue;

          const pRect = pEl.getBoundingClientRect();
          const cRect2 = cEl.getBoundingClientRect();
          const edgeGates = gatesByEdge.get(`${dep}\x00${member.job_name}`) ?? [];

          let x1: number, y1: number, x2: number, y2: number, d: string, midX: number, midY: number;

          if (!vertical) {
            // Desktop (L→R): producer right-center → consumer left-center.
            x1 = pRect.right - iRect.left;
            y1 = pRect.top + pRect.height / 2 - iRect.top;
            x2 = cRect2.left - iRect.left;
            y2 = cRect2.top + cRect2.height / 2 - iRect.top;
            const cp = Math.max(20, (x2 - x1) * 0.45);
            d = `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`;
            midX = (x1 + x2) / 2;
            midY = (y1 + y2) / 2;
          } else {
            // Mobile (top-to-bottom): producer bottom-center → consumer top-center.
            x1 = pRect.left + pRect.width / 2 - iRect.left;
            y1 = pRect.bottom - iRect.top;
            x2 = cRect2.left + cRect2.width / 2 - iRect.left;
            y2 = cRect2.top - iRect.top;
            const cp = Math.max(20, (y2 - y1) * 0.45);
            d = `M ${x1} ${y1} C ${x1} ${y1 + cp}, ${x2} ${y2 - cp}, ${x2} ${y2}`;
            midX = (x1 + x2) / 2;
            midY = (y1 + y2) / 2;
          }

          drawn.push({ d, midX, midY, gates: edgeGates });
        }
      }

      setEdgesDrawn(drawn);
      setSvgSize({ w: inner.offsetWidth, h: inner.offsetHeight });
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(inner);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, gates, structuralGates, workflowRunId, workflowName]);

  return (
    <div className="dag">
      <div className="dag-inner" ref={innerRef}>
        {/* SVG overlay: one bezier path per dependency edge */}
        {svgSize.w > 0 && edgesDrawn.length > 0 && (
          <svg
            aria-hidden="true"
            style={{
              position: 'absolute', top: 0, left: 0,
              width: svgSize.w, height: svgSize.h,
              pointerEvents: 'none', overflow: 'visible',
              zIndex: 0,
            }}
          >
            {edgesDrawn.map((e, idx) => (
              <path key={idx} d={e.d} className="dag-edge-path" />
            ))}
          </svg>
        )}
        {/* Gate marks positioned at each edge's midpoint */}
        {edgesDrawn.map((e, idx) =>
          e.gates.length > 0 ? (
            <div
              key={`g-${idx}`}
              style={{
                position: 'absolute',
                left: e.midX,
                top: e.midY,
                transform: 'translate(-50%, -50%)',
                zIndex: 2,
                pointerEvents: 'auto',
              }}
            >
              <GateMarks gates={e.gates} />
            </div>
          ) : null
        )}
        {/* Topological columns: each column holds all nodes at that dependency depth */}
        {columns.map((col, colIdx) => (
          <div key={colIdx} className="dag-col">
            {col.map((job) => {
              const status = statusByJob?.[job] ?? 'pending';
              const runId = runIdByJob?.[job];
              const href =
                (runId ? `/runs/${runId}` : `/jobs/${job}`) +
                (from ? `?from=${encodeURIComponent(from)}` : '');
              return (
                <div key={job} data-dag-job={job} style={{ position: 'relative', zIndex: 1 }}>
                  <a href={href} style={{ textDecoration: 'none' }}>
                    <div className={`dag-node ${status}`}>
                      <div className="dag-node-name">{job}</div>
                      {statusByJob && <div className="dag-node-status">{statusLabel(status)}</div>}
                    </div>
                  </a>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
