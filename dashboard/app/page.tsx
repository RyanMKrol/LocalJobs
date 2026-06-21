'use client';

import { api } from './lib/api';
import { StatusBadge, fmtDuration, fmtRelative, usePoll } from './ui';

export default function Overview() {
  const { data, error } = usePoll(() => api.recentRuns(100), 2000);
  const { data: stuckData } = usePoll(() => api.stuck(), 5000);
  const runs = data?.runs ?? [];
  const stuck = stuckData?.stuck ?? [];

  async function unstick(job: string, key: string) {
    try { await api.unstick(job, key); } catch { /* next poll reflects reality */ }
  }

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
        <div className="statcard"><div className="n" style={{ color: 'var(--red)' }}>{counts.failed}</div><div className="l">Failed runs</div></div>
        <div className="statcard"><div className="n" style={{ color: stuck.length ? 'var(--red)' : undefined }}>{stuck.length}</div><div className="l">Stuck items</div></div>
      </div>

      <h2>⛔ Stuck items <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>— gave up, will NOT retry</span></h2>
      <div className="panel" style={stuck.length ? { borderColor: 'var(--red)' } : undefined}>
        <table>
          <thead>
            <tr><th>Item</th><th>Job</th><th>Attempts</th><th>Reason</th><th>When</th><th></th></tr>
          </thead>
          <tbody>
            {stuck.length === 0 && (
              <tr><td colSpan={6} className="muted">Nothing stuck — every item either succeeded or is still retrying. ✓</td></tr>
            )}
            {stuck.map((s) => (
              <tr key={`${s.job_name}:${s.item_key}`}>
                <td>{s.detail?.name ?? <span className="mono">{s.item_key}</span>}</td>
                <td><a href={`/jobs/${s.job_name}`}>{s.job_name}</a></td>
                <td>{s.attempts}</td>
                <td className="muted">{s.detail?.error ?? s.detail?.status ?? '—'}{s.detail?.pageTitle ? ` · title="${s.detail.pageTitle}"` : ''}</td>
                <td className="muted">{fmtRelative(s.updated_at)}</td>
                <td><button className="btn" onClick={() => unstick(s.job_name, s.item_key)}>↻ Unstick</button></td>
              </tr>
            ))}
          </tbody>
        </table>
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
