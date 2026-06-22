'use client';

import { Fragment } from 'react';
import type { GateStatus, WorkflowMember } from '../lib/api';

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

/** Stable DOM id for a gate's detail row, shared by its chip link + the panel. */
export function gateAnchor(g: { producer: string; key: string }): string {
  return `gate-${`${g.producer}-${g.key}`.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
}

/**
 * Render the validation gates inbound to one consumer node as small chips, each
 * naming its producer + artifact key and coloured by state. EVERY chip (passed,
 * failed, or pending) links to that gate's detail row on the workflow-run page,
 * so any gate can be inspected — not just failures. Gates are only supplied on a
 * workflow RUN, so the structure-only /workflows/[name] view renders no chips.
 */
function GateChips({ gates }: { gates: GateStatus[] }) {
  if (gates.length === 0) return null;
  return (
    <div className="dag-gates">
      {gates.map((g) => {
        const label = `⛒ ${g.producer} · ${g.key}`;
        const title = `gate ${g.state}: ${g.producer} → ${g.consumer} (artifact "${g.key}") — click for detail`;
        return (
          <a key={`${g.producer}:${g.key}`} href={`#${gateAnchor(g)}`} className={`dag-gate ${g.state}`} title={title}>
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
 * mark each producer→consumer validation gate on its consumer node — a failed
 * gate is red and links to its failure logs.
 */
export function Dag({
  members,
  statusByJob,
  runIdByJob,
  gates,
  from,
}: {
  members: WorkflowMember[];
  statusByJob?: Record<string, string>;
  runIdByJob?: Record<string, string>;
  /** Validation-gate states for THIS run; omit on the structure-only view. */
  gates?: GateStatus[];
  /** Path of the page rendering this DAG, threaded onto node links as `?from=`
   *  so the job/run page can send the back-link to where you actually came from. */
  from?: string;
}) {
  const waves = computeWaves(members);
  // Group gates by consumer so each node shows its own inbound gates.
  const gatesByConsumer = new Map<string, GateStatus[]>();
  for (const g of gates ?? []) (gatesByConsumer.get(g.consumer) ?? gatesByConsumer.set(g.consumer, []).get(g.consumer)!).push(g);
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
                  {statusByJob && <div className="dag-node-status">{status}</div>}
                </div>
              );
              const href = (runId ? `/runs/${runId}` : `/jobs/${job}`) + (from ? `?from=${encodeURIComponent(from)}` : '');
              return (
                <div key={job}>
                  <a href={href} style={{ textDecoration: 'none' }}>{node}</a>
                  <GateChips gates={gatesByConsumer.get(job) ?? []} />
                </div>
              );
            })}
          </div>
          {i < waves.length - 1 && <div className="dag-arrow">→</div>}
        </Fragment>
      ))}
    </div>
  );
}
