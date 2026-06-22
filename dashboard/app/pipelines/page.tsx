'use client';

import { api } from '../lib/api';
import { StatusBadge, fmtRelative, fmtTime, usePoll } from '../ui';

export default function Pipelines() {
  const { data, error } = usePoll(() => api.pipelines(), 3000);
  const { data: jobsData } = usePoll(() => api.jobs(), 5000);
  const pipelines = data?.pipelines ?? [];
  const standaloneJobs = (jobsData?.jobs ?? []).filter((j) => !j.pipeline);

  async function run(name: string) {
    try { await api.runPipeline(name); } catch { /* next poll reflects reality */ }
  }

  return (
    <>
      <h1>Pipelines</h1>
      <p className="sub">DAGs of jobs the framework runs as a unit. Auto-refreshes every 3s.</p>
      {error && <p className="muted">⚠ Cannot reach the daemon API ({error}).</p>}
      <div className="panel">
        <table>
          <thead>
            <tr><th>Pipeline</th><th>Stages</th><th>Schedule</th><th>Last run</th><th>Next</th><th></th></tr>
          </thead>
          <tbody>
            {pipelines.length === 0 && (
              <tr><td colSpan={6} className="muted">No pipelines yet — drop a <span className="mono">*.pipeline.ts</span> in src/jobs.</td></tr>
            )}
            {pipelines.map((p) => (
              <tr key={p.name}>
                <td>
                  <a href={`/pipelines/${p.name}`}><strong>{p.name}</strong></a>
                  {p.stuck > 0 && <span style={{ color: 'var(--red)', fontSize: 12, marginLeft: 8 }}>⛔ {p.stuck} stuck</span>}
                  <div className="muted" style={{ fontSize: 12 }}>{p.description}</div>
                </td>
                <td className="muted">{p.jobs.length}</td>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>{p.schedule ?? <span className="muted">manual</span>}{p.enabled ? '' : ' (off)'}</td>
                <td>
                  {p.last_run
                    ? <><span className={`badge ${p.last_run.status}`}>{p.last_run.status}</span> <span className="muted">{fmtRelative(p.last_run.started_at)}</span></>
                    : <span className="muted">never</span>}
                </td>
                <td className="muted">{p.next_run ? fmtTime(p.next_run) : '—'}</td>
                <td><button className="btn" onClick={() => run(p.name)}>▶ Run</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Standalone jobs</h2>
      <p className="sub">Jobs not part of any pipeline. Click a job to view its run history.</p>
      <div className="panel">
        <table>
          <thead>
            <tr><th>Job</th><th>Schedule</th><th>Last run</th><th>Next</th></tr>
          </thead>
          <tbody>
            {standaloneJobs.length === 0 && (
              <tr><td colSpan={4} className="muted">No standalone jobs — all jobs belong to a pipeline.</td></tr>
            )}
            {standaloneJobs.map((j) => (
              <tr key={j.name}>
                <td>
                  <a href={`/jobs/${j.name}`}><strong>{j.name}</strong></a>
                  {j.stuck > 0 && <span style={{ color: 'var(--red)', fontSize: 12, marginLeft: 8 }}>⛔ {j.stuck} stuck</span>}
                  <div className="muted" style={{ fontSize: 12 }}>{j.description}</div>
                </td>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>{j.schedule ?? <span className="muted">manual</span>}</td>
                <td>
                  {j.last_run
                    ? <><StatusBadge status={j.last_run.status} /> <span className="muted">{fmtRelative(j.last_run.started_at)}</span></>
                    : <span className="muted">never</span>}
                </td>
                <td className="muted">{j.next_run ? fmtTime(j.next_run) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
