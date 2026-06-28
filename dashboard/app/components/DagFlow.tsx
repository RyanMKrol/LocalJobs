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
 *  - Edges have arrowheads; gate marks appear as edge labels.
 *
 * Libraries: @xyflow/react ^12, @dagrejs/dagre.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeTypes,
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
    <a href={data.href} style={{ textDecoration: 'none', pointerEvents: 'auto' }}>
      <Handle type="target" position={Position.Left} isConnectable={false} style={{ opacity: 0, border: 'none', background: 'transparent' }} />
      <div className={`dag-node rf-dag-node ${data.status}`} style={{ cursor: 'pointer', minWidth: 156 }}>
        <div className="dag-node-name">{data.label}</div>
        {data.showStatus && <div className="dag-node-status">{statusLabel(data.status)}</div>}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} style={{ opacity: 0, border: 'none', background: 'transparent' }} />
    </a>
  );
}

const nodeTypes: NodeTypes = {
  stage: StageNode as NodeTypes['stage'],
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

  // Gate label lookup: "producer\x00consumer" → label string
  const gateLabelByEdge = new Map<string, string>();
  const runGateHref = (runId: string, g2: { producer: string; key: string }) =>
    `/workflow-runs/${runId}/gates/${encodeURIComponent(g2.producer)}/${encodeURIComponent(g2.key)}`;
  const defGateHref = (name: string, g2: { producer: string; key: string }) =>
    `/workflows/${encodeURIComponent(name)}/gates/${encodeURIComponent(g2.producer)}/${encodeURIComponent(g2.key)}`;

  const allGates: Array<{ key: string; producer: string; consumer: string; state?: string; href?: string }> = [];
  for (const gt of gates ?? []) {
    const href = workflowRunId ? runGateHref(workflowRunId, gt) : undefined;
    allGates.push({ key: gt.key, producer: gt.producer, consumer: gt.consumer, state: gt.state, href });
  }
  for (const gt of structuralGates ?? []) {
    const href = workflowName ? defGateHref(workflowName, gt) : undefined;
    allGates.push({ key: gt.key, producer: gt.producer, consumer: gt.consumer, state: 'structural', href });
  }
  for (const gt of allGates) {
    const k = `${gt.producer}\x00${gt.consumer}`;
    gateLabelByEdge.set(k, gt.key);
  }

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Stage nodes
  for (const m of members) {
    const { y } = g.node(m.job_name);          // dagre's vertical position (crossing-minimised order)
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

  // Dependency edges
  for (const m of members) {
    for (const dep of m.depends_on) {
      const edgeKey = `${dep}\x00${m.job_name}`;
      const gateLabel = gateLabelByEdge.get(edgeKey);
      const gateData = allGates.find((gt) => gt.producer === dep && gt.consumer === m.job_name);
      const gateHref = gateData?.href;
      // A gate mark is a clickable link to its detail page (matching the other graph styles), so it
      // needs pointer-events re-enabled (React Flow edge labels are non-interactive by default).
      const label: ReactNode = gateLabel
        ? (gateHref
            ? <a href={gateHref} style={{ color: 'var(--muted)', textDecoration: 'none', pointerEvents: 'all', cursor: 'pointer' }}>{gateLabel}</a>
            : gateLabel)
        : undefined;
      edges.push({
        id: `${dep}->${m.job_name}`,
        source: dep,
        target: m.job_name,
        label,
        labelStyle: { fill: 'var(--muted)', fontSize: 10 },
        labelBgStyle: { fill: 'var(--panel-2)', fillOpacity: 0.9 },
        style: {
          stroke: gateData?.state === 'failed' ? 'var(--red)' : 'var(--grey)',
          strokeWidth: 1.5,
          opacity: 0.6,
        },
        animated: false,
        // bezier (default) curves fan cleanly from one source to many targets, instead of the
        // smoothstep orthogonal "bus" that made the parallel branches look chained together.
        type: 'default',
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
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.3}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}
