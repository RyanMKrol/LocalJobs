'use client';

import { useEffect, useRef, useState } from 'react';
import type { GateStatus, StructuralGate, WorkflowMember } from '../lib/api';
import { statusLabel } from '../ui';

/**
 * Option B — Horizontal Swim-Lane view.
 *
 * Each wave occupies a labelled horizontal row (swim lane). Stages within the same
 * wave sit side-by-side in their row, making it visually obvious they run concurrently.
 * Dependency edges are drawn as SVG bezier curves from the producer's bottom-center to
 * the consumer's top-center, routing across rows.
 *
 * Key concurrency signals:
 *  - The swim lane header reads "Wave N · M stages run concurrently"
 *  - All nodes in the same horizontal band share the same background tint
 *  - Edges only cross row boundaries (always downward), never within a row
 *
 * Library: none (hand-rolled SVG + CSS flexbox).
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
  for (const n of names) if (!layer.has(n)) layer.set(n, 0);
  return layer;
}

type GateState = 'passed' | 'failed' | 'pending' | 'structural';
interface RenderGate { key: string; producer: string; consumer: string; description?: string | null; state: GateState; href?: string; }

function gateTitle(g: RenderGate): string {
  const base = `${g.producer} → ${g.consumer} (artifact "${g.key}")`;
  const desc = g.description ? ` — ${g.description}` : '';
  return g.state === 'structural' ? `gate: ${base}${desc}` : `gate ${g.state}: ${base}${desc} — click for detail`;
}

interface EdgeDraw { d: string; midX: number; midY: number; gates: RenderGate[]; }

export function DagSwimlane({
  members, statusByJob, runIdByJob, gates, structuralGates, workflowName, from, workflowRunId,
}: {
  members: WorkflowMember[];
  statusByJob?: Record<string, string>;
  runIdByJob?: Record<string, string>;
  gates?: GateStatus[];
  structuralGates?: StructuralGate[];
  workflowName?: string;
  from?: string;
  workflowRunId?: string;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [edgesDrawn, setEdgesDrawn] = useState<EdgeDraw[]>([]);
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });

  const layerOf = computeLayers(members);
  const numRows = members.length === 0 ? 0 : Math.max(...Array.from(layerOf.values())) + 1;
  const rows: string[][] = Array.from({ length: numRows }, () => []);
  for (const m of members) rows[layerOf.get(m.job_name) ?? 0].push(m.job_name);

  const runGateHref = (runId: string, g: { producer: string; key: string }) =>
    `/workflow-runs/${runId}/gates/${encodeURIComponent(g.producer)}/${encodeURIComponent(g.key)}`;
  const defGateHref = (name: string, g: { producer: string; key: string }) =>
    `/workflows/${encodeURIComponent(name)}/gates/${encodeURIComponent(g.producer)}/${encodeURIComponent(g.key)}`;

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

  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const compute = () => {
      const iRect = inner.getBoundingClientRect();
      const drawn: EdgeDraw[] = [];
      for (const member of members) {
        for (const dep of member.depends_on) {
          const pEl = inner.querySelector<HTMLElement>(`[data-dag-job="${dep.replace(/"/g, '\\"')}"] .dag-node`);
          const cEl = inner.querySelector<HTMLElement>(`[data-dag-job="${member.job_name.replace(/"/g, '\\"')}"] .dag-node`);
          if (!pEl || !cEl) continue;
          const pRect = pEl.getBoundingClientRect();
          const cRect2 = cEl.getBoundingClientRect();
          const edgeGates = gatesByEdge.get(`${dep}\x00${member.job_name}`) ?? [];

          // Swimlane: edges always go downward (producer row → consumer row).
          const x1 = pRect.left + pRect.width / 2 - iRect.left;
          const y1 = pRect.bottom - iRect.top;
          const x2 = cRect2.left + cRect2.width / 2 - iRect.left;
          const y2 = cRect2.top - iRect.top;
          const dy = y2 - y1;
          const cp = Math.max(16, dy * 0.4);
          const d = `M ${x1} ${y1} C ${x1} ${y1 + cp}, ${x2} ${y2 - cp}, ${x2} ${y2}`;
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;
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
    <div className="dag dag-swimlane-wrap">
      <div className="dag-swimlane-inner" ref={innerRef}>
        {svgSize.w > 0 && edgesDrawn.length > 0 && (
          <svg aria-hidden="true" style={{ position: 'absolute', top: 0, left: 0, width: svgSize.w, height: svgSize.h, pointerEvents: 'none', overflow: 'visible', zIndex: 0 }}>
            {edgesDrawn.map((e, idx) => <path key={idx} d={e.d} className="dag-edge-path" />)}
          </svg>
        )}
        {edgesDrawn.map((e, idx) =>
          e.gates.length > 0 ? (
            <div key={`g-${idx}`} style={{ position: 'absolute', left: e.midX, top: e.midY, transform: 'translate(-50%, -50%)', zIndex: 2, pointerEvents: 'auto' }}>
              <div className="dag-gates gs-key">
                {e.gates.map((g) => {
                  const cls = `dag-gate gs-key ${g.state}`;
                  const title = gateTitle(g);
                  return g.href ? (
                    <a key={`${g.producer}:${g.key}`} href={g.href} className={cls} title={title}>{g.key}</a>
                  ) : (
                    <span key={`${g.producer}:${g.key}`} className={cls} title={title}>{g.key}</span>
                  );
                })}
              </div>
            </div>
          ) : null
        )}
        {rows.map((row, rowIdx) => (
          <div key={rowIdx} className={`dag-swimlane-row dag-swimlane-row-${rowIdx % 2}`}>
            {/* Lane label on the left */}
            <div className="dag-swimlane-label">
              <span className="dag-wave-label">Wave {rowIdx + 1}</span>
              {row.length > 1 && (
                <span className="dag-wave-count" title={`${row.length} stages share this wave`}>
                  ×{row.length}
                </span>
              )}
            </div>
            {/* Nodes in this wave, side-by-side */}
            <div className="dag-swimlane-nodes">
              {row.map((job) => {
                const status = statusByJob?.[job] ?? 'pending';
                const runId = runIdByJob?.[job];
                const href = (runId ? `/runs/${runId}` : `/jobs/${job}`) + (from ? `?from=${encodeURIComponent(from)}` : '');
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
          </div>
        ))}
      </div>
    </div>
  );
}
