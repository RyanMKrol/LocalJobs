'use client';

import { use } from 'react';
import { Dag } from '../../components/Dag';
import { api } from '../../lib/api';
import type { GateStatus, Run } from '../../lib/api';
import { StatusBadge, fmtDuration, fmtRelative, statusLabel, usePoll } from '../../ui';

function latestByStage(members: Run[]): Run[] {
  const latest = new Map<string, Run>();
  // members are ordered by start time ascending; later writes overwrite earlier ones
  // so the final value per key is the latest run. Map preserves first-insertion order
  // (updating an existing key keeps its position), so stage order is maintained.
  for (const r of members) latest.set(r.job_name, r);
  return [...latest.values()];
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
                  <a style={{ whiteSpace: 'nowrap' }} href={`/workflow-runs/${id}/gates/${encodeURIComponent(g.producer)}/${encodeURIComponent(g.key)}`}>
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

  const latestRuns = latestByStage(members);

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
          <thead><tr><th>Stage</th><th>Status</th><th>When</th><th>Duration</th><th></th></tr></thead>
          <tbody>
            {members.length === 0 && <tr><td colSpan={5} className="muted">No member runs yet.</td></tr>}
            {latestRuns.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.job_name}</strong></td>
                <td><StatusBadge status={r.status} /></td>
                <td className="muted">{fmtRelative(r.started_at)}</td>
                <td className="mono">{fmtDuration(r.duration_ms)}</td>
                <td><a href={`/runs/${r.id}`}>logs →</a></td>
              </tr>
            ))}
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
