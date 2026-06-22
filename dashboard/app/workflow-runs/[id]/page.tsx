'use client';

import { use, useState } from 'react';
import { Dag } from '../../components/Dag';
import { api } from '../../lib/api';
import type { GateStatus, Run } from '../../lib/api';
import { StatusBadge, fmtDuration, fmtRelative, statusLabel, usePoll } from '../../ui';

function groupByStage(members: Run[]): Map<string, Run[]> {
  const groups = new Map<string, Run[]>();
  for (const r of members) {
    const list = groups.get(r.job_name) ?? [];
    list.push(r);
    groups.set(r.job_name, list);
  }
  // Within each group: latest first (members are start-time ordered, so reverse)
  for (const [, list] of groups) list.reverse();
  return groups;
}

/**
 * Summary of all validation gates for this workflow run. Each row links to that
 * gate's dedicated detail page (navigating there like a job node does), so the
 * panel is a quick overview rather than the canonical detail view.
 */
function GatePanel({ id, gates }: { id: string; gates: GateStatus[] }) {
  if (gates.length === 0) return null;
  return (
    <>
      <h2>Validation gates</h2>
      <div className="panel">
        <table>
          <thead><tr><th>State</th><th>Gate</th><th>Asserts</th><th></th></tr></thead>
          <tbody>
            {gates.map((g) => (
              <tr key={`${g.producer}:${g.key}`}>
                <td><span className={`badge ${g.state}`}>{statusLabel(g.state)}</span></td>
                <td>
                  <div><strong>{g.producer}</strong> → <strong>{g.consumer}</strong></div>
                  <div className="muted mono">artifact &ldquo;{g.key}&rdquo;</div>
                </td>
                <td className="muted">{g.description ?? <span className="mono">no contract description</span>}</td>
                <td>
                  <a href={`/workflow-runs/${id}/gates/${encodeURIComponent(g.producer)}/${encodeURIComponent(g.key)}`}>
                    detail →
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function WorkflowRunDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data } = usePoll(() => api.workflowRun(id), 2000, [id]);
  const run = data?.run;
  const members = data?.jobs ?? [];
  const logs = data?.logs ?? [];
  const gates = data?.gates ?? [];

  // Which stage rows are expanded to show older runs
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Fetch the workflow definition (for the DAG edges) once we know its name.
  const { data: pdata } = usePoll(
    () => api.workflow(run?.workflow_name ?? '__none__'),
    5000,
    [run?.workflow_name],
  );
  const workflow = pdata?.workflow;

  // Latest member run per stage (members are ordered by start time).
  const statusByJob: Record<string, string> = {};
  const runIdByJob: Record<string, string> = {};
  for (const r of members) { statusByJob[r.job_name] = r.status; runIdByJob[r.job_name] = r.id; }

  const groups = groupByStage(members);

  const toggleExpand = (jobName: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(jobName)) next.delete(jobName);
      else next.add(jobName);
      return next;
    });
  };

  return (
    <>
      <p className="muted"><a href={run ? `/workflows/${run.workflow_name}` : '/workflows'}>← {run?.workflow_name ?? 'workflows'}</a></p>
      <div className="row">
        <h1 style={{ margin: 0 }}>Workflow run</h1>
        <div className="spacer" />
        {run && <span className={`badge ${run.status}`}>{statusLabel(run.status)}</span>}
      </div>
      <p className="sub">{run?.progress_msg}{run ? ` · ${run.progress}%` : ''}{run?.duration_ms != null ? ` · ${fmtDuration(run.duration_ms)}` : ''}</p>

      {workflow && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <Dag members={workflow.jobs} statusByJob={statusByJob} runIdByJob={runIdByJob} gates={gates} from={`/workflow-runs/${id}`} workflowRunId={id} />
        </div>
      )}

      <GatePanel id={id} gates={gates} />

      <h2>Member runs</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Stage</th><th>Status</th><th>When</th><th>Duration</th><th></th><th></th></tr></thead>
          <tbody>
            {members.length === 0 && <tr><td colSpan={6} className="muted">No member runs yet.</td></tr>}
            {[...groups.entries()].map(([jobName, runs]) => {
              const latest = runs[0];
              const older = runs.slice(1);
              const isExpanded = expanded.has(jobName);
              return (
                <>
                  <tr key={latest.id}>
                    <td><strong>{latest.job_name}</strong></td>
                    <td><StatusBadge status={latest.status} /></td>
                    <td className="muted">{fmtRelative(latest.started_at)}</td>
                    <td className="mono">{fmtDuration(latest.duration_ms)}</td>
                    <td><a href={`/runs/${latest.id}`}>logs →</a></td>
                    <td>
                      {older.length > 0 && (
                        <button
                          onClick={() => toggleExpand(jobName)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', fontSize: '0.85em', color: 'var(--muted)' }}
                        >
                          {isExpanded ? `▲ hide` : `▼ +${older.length}`}
                        </button>
                      )}
                    </td>
                  </tr>
                  {isExpanded && older.map((r) => (
                    <tr key={r.id} style={{ opacity: 0.65 }}>
                      <td style={{ paddingLeft: '1.5rem' }}>{r.job_name}</td>
                      <td><StatusBadge status={r.status} /></td>
                      <td className="muted">{fmtRelative(r.started_at)}</td>
                      <td className="mono">{fmtDuration(r.duration_ms)}</td>
                      <td><a href={`/runs/${r.id}`}>logs →</a></td>
                      <td></td>
                    </tr>
                  ))}
                </>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>Framework logs</h2>
      <div className="logs">
        {logs.length === 0 && <span className="muted">No framework logs yet.</span>}
        {logs.map((l) => (
          <div key={l.id} className={`lvl-${l.level}`}>
            <span className="ts">{l.ts.split(' ')[1] ?? l.ts}</span>{l.message}
          </div>
        ))}
      </div>
    </>
  );
}
