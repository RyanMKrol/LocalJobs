'use client';

/**
 * Option C — React Flow view.
 *
 * Uses @xyflow/react (React Flow v12) for a professional interactive node-edge graph.
 * Node positions are computed by @dagrejs/dagre with LR (left-to-right) ranking so
 * each rank corresponds to one wave. Wave membership is shown as translucent background
 * "wave band" nodes behind the stage nodes.
 *
 * Key concurrency signals:
 *  - Dagre ranks nodes by wave; parallel stages in the same rank are stacked vertically
 *    at the same X position, visually grouped together.
 *  - A "Wave N (M concurrent)" background group node spans behind each rank's stages.
 *  - Edges have arrowheads; gate marks appear as EdgeLabelRenderer overlays.
 *
 * Libraries: @xyflow/react ^12, @dagrejs/dagre.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ReactFlow,
  Background,
  Handle,
  Position,
  EdgeLabelRenderer,
  getBezierPath,
  BaseEdge,
  type Node,
  type Edge,
  type EdgeProps,
  type NodeTypes,
  type EdgeTypes,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import * as dagre from '@dagrejs/dagre';
import type { GateStatus, StructuralGate, WorkflowMember } from '../lib/api';
import { statusLabel } from '../ui';

// ─── Custom node types ───────────────────────────────────────────────────────

/** A stage node styled to match the existing .dag-node appearance. */
function StageNode({ data }: { data: { label: string; status: string; href: string; showStatus: boolean } }) {
  // React Flow draws edges between node HANDLES — a custom node with no <Handle> has no anchor
  // points, so edges silently don't render. Layout is LR (rankdir 'LR'), so the target handle is on
  // the left and the source handle on the right. Hidden + non-connectable (this is a read-only DAG),
  // but they MUST exist for the dependency edges to draw.
  return (
    <Link href={data.href} style={{ textDecoration: 'none', pointerEvents: 'auto' }}>
      <Handle type="target" position={Position.Left} isConnectable={false} style={{ opacity: 0, border: 'none', background: 'transparent' }} />
      <div className={`dag-node rf-dag-node ${data.status}`} style={{ cursor: 'pointer', minWidth: 156 }}>
        <div className="dag-node-name">{data.label}</div>
        {data.showStatus && <div className="dag-node-status">{statusLabel(data.status)}</div>}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} style={{ opacity: 0, border: 'none', background: 'transparent' }} />
    </Link>
  );
}

// ─── Custom edge type with EdgeLabelRenderer gate mark ───────────────────────

interface GateEdgeData extends Record<string, unknown> {
  gateHref?: string;
  gateState?: string;
  tooltipText?: string;
  isFailed?: boolean;
  isPassed?: boolean;
}

// Full edge type needed for EdgeProps generic in React Flow v12
type GateEdgeType = Edge<GateEdgeData, 'gateEdge'>;

/**
 * Custom edge that renders the gate padlock via EdgeLabelRenderer — an HTML portal
 * overlay positioned at the edge midpoint. This lets the <a>/<svg> padlock actually
 * paint, unlike the built-in edge's <text>-based label renderer which silently hides
 * HTML content via a zero-width getBBox() → visibility:hidden.
 */
function GateEdge({
  id,
  sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  style, markerEnd, data,
}: EdgeProps<GateEdgeType>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });

  const gateHref = data?.gateHref;
  const gateState = data?.gateState;
  const tooltipText = data?.tooltipText;
  const isFailed = !!data?.isFailed;
  const isPassed = !!data?.isPassed;
  const hasGate = !!gateState;

  const lockColor = isFailed ? 'var(--red)' : isPassed ? 'var(--green)' : 'var(--muted)';
  const lockFill = `color-mix(in srgb, ${lockColor} 18%, transparent)`;
  // Background "badge" behind the padlock — a bit stronger than the icon's own internal
  // fill (lockFill) so the pending/grey state still reads as a distinct chip against the
  // dotted graph background, not just a faint tint (confirmed via visual-check, T377).
  const lockBg = `color-mix(in srgb, ${lockColor} 24%, transparent)`;
  const lockSize = isFailed ? 20 : 16;

  // SVG padlock: shackle arc + body rectangle, stroked in the state colour.
  const padlockSvg = (
    <svg
      width={lockSize} height={lockSize}
      viewBox="0 0 16 16"
      fill="none"
      stroke={lockColor}
      strokeWidth={isFailed ? 2.1 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}
      aria-hidden="true"
    >
      {/* Shackle arc */}
      <path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2" />
      {/* Body */}
      <rect x="2.5" y="7" width="11" height="8" rx="1.5" fill={lockFill} />
    </svg>
  );

  const lockClass = `dag-gate-lock${isFailed ? ' dag-gate-lock--failed' : isPassed ? ' dag-gate-lock--passed' : ''}`;

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      {hasGate && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
              background: 'var(--panel-2)',
              borderRadius: 4,
              padding: '2px 3px',
              lineHeight: 0,
            }}
          >
            {gateHref ? (
              <Link
                href={gateHref}
                title={tooltipText}
                className={lockClass}
                style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', ['--lock-bg' as string]: lockBg }}
                aria-label={tooltipText}
              >
                {padlockSvg}
              </Link>
            ) : (
              <span
                title={tooltipText}
                className={lockClass}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', ['--lock-bg' as string]: lockBg }}
                aria-label={tooltipText}
              >
                {padlockSvg}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes: NodeTypes = {
  stage: StageNode as NodeTypes['stage'],
};

const edgeTypes: EdgeTypes = {
  gateEdge: GateEdge as EdgeTypes['gateEdge'],
};

// ─── Layout computation ──────────────────────────────────────────────────────

const NODE_W = 180;
const NODE_H = 58;
const NODE_SEP = 28;    // vertical gap between nodes in the same rank (more room for fan-out edges)
const RANK_SEP = 110;   // horizontal gap between ranks

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

interface LayoutResult { nodes: Node[]; edges: Edge[]; }

function buildLayout(
  members: WorkflowMember[],
  statusByJob?: Record<string, string>,
  runIdByJob?: Record<string, string>,
  gates?: GateStatus[],
  structuralGates?: StructuralGate[],
  workflowName?: string,
  workflowRunId?: string,
  from?: string,
): LayoutResult {
  if (members.length === 0) return { nodes: [], edges: [] };

  // Build dagre graph for layout. We use dagre for the VERTICAL ordering (crossing minimisation
  // within each column) but OVERRIDE the horizontal position so each node's column = its true wave
  // depth (computeLayers). Dagre's ranker would otherwise pull a short-path node like franchise-gaps
  // (one hop off the snapshot, but feeding the final notify) toward its consumer, stranding it
  // between columns so the snapshot→franchise edge slices through the rec fan-out. Pinning X by wave
  // keeps franchise-gaps in wave 2 with the rec branches, exactly where the run actually places it.
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const m of members) g.setNode(m.job_name, { width: NODE_W, height: NODE_H });
  for (const m of members) for (const dep of m.depends_on) g.setEdge(dep, m.job_name);
  dagre.layout(g);

  // Column X is pinned to the true wave depth (not dagre's rank).
  const wave = computeLayers(members);
  const colX = (job: string) => 16 + (wave.get(job) ?? 0) * (NODE_W + RANK_SEP);

  // Dagre's Y is only guaranteed non-overlapping among nodes it placed in the SAME rank.
  // Since X is pinned to the true wave column (not dagre's own rank), a node's dagre rank
  // can legitimately differ from the wave column it's actually drawn in — e.g. franchise-gaps
  // is one dagre-rank closer to its consumer than the rec-* branches, so dagre's Y for it can
  // coincidentally land very close to a node from a DIFFERENT rank that happens to share its
  // visual column. Re-derive Y per wave-column: keep dagre's relative (crossing-minimised) order
  // within the column, but assign evenly-spaced Y positions so every node actually drawn beside
  // another has the same guaranteed gap, regardless of which dagre rank it came from.
  const columnY = new Map<string, number>();
  {
    const byWave = new Map<number, string[]>();
    for (const m of members) {
      const w = wave.get(m.job_name) ?? 0;
      if (!byWave.has(w)) byWave.set(w, []);
      byWave.get(w)!.push(m.job_name);
    }
    for (const jobNames of byWave.values()) {
      jobNames.sort((a, b) => g.node(a).y - g.node(b).y);
      jobNames.forEach((job, i) => columnY.set(job, i * (NODE_H + NODE_SEP)));
    }
  }

  // Gate data lookup: "producer\x00consumer" → gate info
  const runGateHref = (runId: string, g2: { producer: string; key: string }) =>
    `/workflow-runs/${runId}/gates/${encodeURIComponent(g2.producer)}/${encodeURIComponent(g2.key)}`;
  const defGateHref = (name: string, g2: { producer: string; key: string }) =>
    `/workflows/${encodeURIComponent(name)}/gates/${encodeURIComponent(g2.producer)}/${encodeURIComponent(g2.key)}`;

  const allGates: Array<{ key: string; producer: string; consumer: string; state?: string; href?: string; description?: string }> = [];
  for (const gt of gates ?? []) {
    const href = workflowRunId ? runGateHref(workflowRunId, gt) : undefined;
    allGates.push({ key: gt.key, producer: gt.producer, consumer: gt.consumer, state: gt.state, href, description: (gt as { description?: string }).description });
  }
  for (const gt of structuralGates ?? []) {
    const href = workflowName ? defGateHref(workflowName, gt) : undefined;
    allGates.push({ key: gt.key, producer: gt.producer, consumer: gt.consumer, state: 'structural', href, description: (gt as { description?: string }).description });
  }

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Stage nodes
  for (const m of members) {
    const y = (columnY.get(m.job_name) ?? 0) + NODE_H / 2; // re-derived Y, self-consistent within the wave column
    const x = colX(m.job_name) + NODE_W / 2;    // X pinned to the node's true wave column
    const status = statusByJob?.[m.job_name] ?? 'pending';
    const runId = runIdByJob?.[m.job_name];
    const href = (runId ? `/runs/${runId}` : `/jobs/${m.job_name}`) + (from ? `?from=${encodeURIComponent(from)}` : '');
    nodes.push({
      id: m.job_name,
      type: 'stage',
      position: { x: x - NODE_W / 2, y: y - NODE_H / 2 },
      data: { label: m.job_name, status, href, showStatus: !!statusByJob },
      draggable: false,
    });
  }

  // Dependency edges — all use the custom gateEdge type so the padlock renders via
  // EdgeLabelRenderer (an HTML portal) rather than inside an SVG <text>, where it cannot paint.
  for (const m of members) {
    for (const dep of m.depends_on) {
      const gateData = allGates.find((gt) => gt.producer === dep && gt.consumer === m.job_name);
      const gateHref = gateData?.href;
      const gateState = gateData?.state;
      const isFailed = gateState === 'failed';
      const isPassed = gateState === 'passed';
      // Tooltip shows key + description on hover.
      const tooltipText = gateData
        ? [gateData.key, gateData.description].filter(Boolean).join(' — ')
        : undefined;

      const edgeData: GateEdgeData = gateData
        ? { gateHref, gateState, tooltipText, isFailed, isPassed }
        : {};

      edges.push({
        id: `${dep}->${m.job_name}`,
        source: dep,
        target: m.job_name,
        type: 'gateEdge',
        data: edgeData,
        style: {
          stroke: isFailed ? 'var(--red)' : 'var(--grey)',
          strokeWidth: isFailed ? 2 : 1.5,
          opacity: isFailed ? 0.9 : 0.6,
        },
        animated: false,
      });
    }
  }

  return { nodes, edges };
}

// ─── Component ───────────────────────────────────────────────────────────────

export function DagFlow({
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
  const [layout, setLayout] = useState<LayoutResult>({ nodes: [], edges: [] });

  useEffect(() => {
    setLayout(buildLayout(members, statusByJob, runIdByJob, gates, structuralGates, workflowName, workflowRunId, from));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, statusByJob, runIdByJob, gates, structuralGates, workflowName, workflowRunId, from]);

  // Estimate the height needed to show the full graph (based on the tallest wave)
  const layerOf = computeLayers(members);
  const numWaves = members.length === 0 ? 1 : Math.max(...Array.from(layerOf.values())) + 1;
  const waveNodes: string[][] = Array.from({ length: numWaves }, () => []);
  for (const m of members) waveNodes[layerOf.get(m.job_name) ?? 0].push(m.job_name);
  const maxStagesInWave = Math.max(1, ...waveNodes.map((w) => w.length));
  // Increased from 0.15 → 0.25 so React Flow's fitView adds equal breathing room on all four sides.
  // At 0.15 the top/bottom margins were visibly unequal (flush top, sliver bottom) due to how
  // fitView scales the bounding box — a larger padding value zooms out more and symmetrises the gap.
  const FLOW_PADDING = 0.25;
  const graphH = Math.max(180, maxStagesInWave * (NODE_H + NODE_SEP) + 80);

  // Container height scales with the graph's natural height (tallest wave) so a busy workflow like
  // movie-recommendations gets room to breathe and fitView shows it near 1:1, while a simple linear
  // workflow (e.g. perfumes, graphH≈180) stays compact. Capped so a pathological graph can't grow unbounded.
  return (
    <div className="dag dag-flow-wrap" style={{ height: Math.min(graphH, 820) }}>
      <ReactFlow
        nodes={layout.nodes}
        edges={layout.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: FLOW_PADDING }}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        panOnScroll={false}
        panOnDrag={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
      </ReactFlow>
    </div>
  );
}
