'use client';

import { api } from './lib/api';
import { StatusBadge, fmtDuration, fmtRelative, usePoll } from './ui';

export default function Overview() {
  const { data, error } = usePoll(() => api.recentRuns(100), 2000);
  const runs = data?.runs ?? [];

  const counts = {
    running: runs.filter((r) => r.status === 'running').length,
    success: runs.filter((r) => r.status === 'success').length,
    failed: runs.filter((r) => ['failed', 'timeout'].includes(r.status)).length,
    total: runs.length,
  };

  return (
    <>
      <h1>Overview</h1>
      <p className="sub">Recent activity across all jobs. Auto-refreshes every 2s.</p>
      {error && <p className="muted">⚠ Cannot reach daemon at the API ({error}). Is it running?</p>}

      <div className="statcards">
        <div className="statcard"><div className="n">{counts.running}</div><div className="l">Running</div></div>
        <div className="statcard"><div className="n" style={{ color: 'var(--green)' }}>{counts.success}</div><div className="l">Succeeded</div></div>
        <div className="statcard"><div className="n" style={{ color: 'var(--red)' }}>{counts.failed}</div><div className="l">Failed</div></div>
        <div className="statcard"><div className="n">{counts.total}</div><div className="l">Recent runs</div></div>
      </div>

      <h2>Recent runs</h2>
      <div className="panel">
        <table>
          <thead>
            <tr><th>Job</th><th>Status</th><th>Trigger</th><th>Started</th><th>Duration</th><th></th></tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr><td colSpan={6} className="muted">No runs yet — trigger one from a job page.</td></tr>
            )}
            {runs.map((r) => (
              <tr key={r.id}>
                <td><a href={`/jobs/${r.job_name}`}>{r.job_name}</a></td>
                <td><StatusBadge status={r.status} /></td>
                <td className="muted">{r.trigger}</td>
                <td className="muted">{fmtRelative(r.started_at)}</td>
                <td className="mono">{fmtDuration(r.duration_ms)}</td>
                <td><a href={`/runs/${r.id}`}>details →</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
