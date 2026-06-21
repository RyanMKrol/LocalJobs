'use client';

import { use } from 'react';
import { Dag } from '../../components/Dag';
import { api } from '../../lib/api';
import { StatusBadge, fmtDuration, fmtRelative, usePoll } from '../../ui';

export default function PipelineRunDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data } = usePoll(() => api.pipelineRun(id), 2000, [id]);
  const run = data?.run;
  const members = data?.jobs ?? [];
  const logs = data?.logs ?? [];

  // Fetch the pipeline definition (for the DAG edges) once we know its name.
  const { data: pdata } = usePoll(
    () => api.pipeline(run?.pipeline_name ?? '__none__'),
    5000,
    [run?.pipeline_name],
  );
  const pipeline = pdata?.pipeline;

  // Latest member run per stage (members are ordered by start time).
  const statusByJob: Record<string, string> = {};
  const runIdByJob: Record<string, string> = {};
  for (const r of members) { statusByJob[r.job_name] = r.status; runIdByJob[r.job_name] = r.id; }

  return (
    <>
      <p className="muted"><a href={run ? `/pipelines/${run.pipeline_name}` : '/pipelines'}>← {run?.pipeline_name ?? 'pipelines'}</a></p>
      <div className="row">
        <h1 style={{ margin: 0 }}>Pipeline run</h1>
        <div className="spacer" />
        {run && <span className={`badge ${run.status}`}>{run.status}</span>}
      </div>
      <p className="sub">{run?.progress_msg}{run ? ` · ${run.progress}%` : ''}{run?.duration_ms != null ? ` · ${fmtDuration(run.duration_ms)}` : ''}</p>

      {pipeline && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <Dag members={pipeline.jobs} statusByJob={statusByJob} runIdByJob={runIdByJob} />
        </div>
      )}

      <h2>Member runs</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Stage</th><th>Status</th><th>When</th><th>Duration</th><th></th></tr></thead>
          <tbody>
            {members.length === 0 && <tr><td colSpan={5} className="muted">No member runs yet.</td></tr>}
            {members.map((r) => (
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
