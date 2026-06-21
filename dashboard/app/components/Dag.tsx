'use client';

import { Fragment } from 'react';
import type { PipelineMember } from '../lib/api';

/** Topologically order members into waves (jobs in a wave have no ordering). */
function computeWaves(members: PipelineMember[]): string[][] {
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
 * Render a pipeline DAG as left-to-right waves of status-coloured nodes. Pass
 * `statusByJob` to colour each node by a run's member status, and `runIdByJob`
 * to make nodes link into that member's run logs.
 */
export function Dag({
  members,
  statusByJob,
  runIdByJob,
}: {
  members: PipelineMember[];
  statusByJob?: Record<string, string>;
  runIdByJob?: Record<string, string>;
}) {
  const waves = computeWaves(members);
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
                  <div className="dag-node-status">{status}</div>
                </div>
              );
              return (
                <div key={job}>
                  {runId ? <a href={`/runs/${runId}`} style={{ textDecoration: 'none' }}>{node}</a> : node}
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
