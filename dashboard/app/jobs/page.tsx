'use client';

import { api } from '../lib/api';
import { StatusBadge, fmtRelative, fmtTime, usePoll } from '../ui';

export default function JobsList() {
  const { data, error } = usePoll(() => api.jobs(), 3000);
  const jobs = data?.jobs ?? [];

  return (
    <>
      <h1>Jobs</h1>
      <p className="sub">All registered jobs and their schedules.</p>
      {error && <p className="muted">⚠ Cannot reach daemon ({error}).</p>}

      <div className="panel">
        <table>
          <thead>
            <tr><th>Job</th><th>Schedule</th><th>Enabled</th><th>Last run</th><th>Next run</th></tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.name}>
                <td>
                  <a href={`/jobs/${j.name}`}><strong>{j.name}</strong></a>
                  {j.stuck > 0 && (
                    <span style={{ color: 'var(--red)', fontSize: 12, marginLeft: 8 }}>⛔ {j.stuck} stuck</span>
                  )}
                  <div className="muted" style={{ fontSize: 12 }}>{j.description}</div>
                </td>
                <td className="mono">{j.schedule ?? <span className="muted">manual</span>}</td>
                <td>{j.enabled ? 'yes' : <span className="muted">no</span>}</td>
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
