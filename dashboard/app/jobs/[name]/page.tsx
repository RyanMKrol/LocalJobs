'use client';

import { Fragment, use, useState } from 'react';
import { api } from '../../lib/api';
import { StatusBadge, fmtDuration, fmtRelative, fmtTime, usePoll } from '../../ui';

export default function JobDetail({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const [busy, setBusy] = useState(false);

  const { data: jobData } = usePoll(() => api.job(name), 3000, [name]);
  const { data: runsData } = usePoll(() => api.jobRuns(name), 2000, [name]);
  const { data: stuckData } = usePoll(() => api.stuck(name), 5000, [name]);
  const job = jobData?.job;
  const runs = runsData?.runs ?? [];
  const stuck = stuckData?.stuck ?? [];

  async function runNow() {
    setBusy(true);
    try { await api.runNow(name); } finally { setTimeout(() => setBusy(false), 1200); }
  }

  async function toggle() {
    if (!job) return;
    await api.toggle(name, job.enabled === 0);
  }

  async function unstick(key: string) {
    try { await api.unstick(name, key); } catch { /* next poll reflects reality */ }
  }
  async function unstickAll() {
    try { await Promise.all(stuck.map((s) => api.unstick(s.job_name, s.item_key))); } catch { /* ignore */ }
  }

  return (
    <>
      <p className="muted"><a href="/jobs">← Jobs</a></p>
      <div className="row">
        <h1 style={{ margin: 0 }}>{name}</h1>
        <div className="spacer" />
        <button className="btn" onClick={runNow} disabled={busy}>{busy ? 'Started…' : '▶ Run now'}</button>
      </div>
      <p className="sub">{job?.description}</p>

      {job?.instructions && (
        <div className="panel" style={{ padding: 18, marginBottom: 8, borderColor: 'var(--accent)' }}>
          <div className="k" style={{ color: 'var(--accent)', fontWeight: 600, marginBottom: 8 }}>
            ⓘ How to run this job
          </div>
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{job.instructions}</div>
        </div>
      )}

      <div className="panel" style={{ padding: 18, marginBottom: 8 }}>
        <div className="kv">
          <div className="k">Schedule</div><div className="mono">{job?.schedule ?? 'manual-only'}</div>
          <div className="k">Enabled</div>
          <div>
            <span className="toggle" onClick={toggle}>
              <input type="checkbox" checked={!!job?.enabled} readOnly /> {job?.enabled ? 'enabled' : 'disabled'} (click to toggle)
            </span>
          </div>
          <div className="k">Timeout</div><div>{job?.timeout_ms ? `${job.timeout_ms} ms` : 'none'}</div>
          <div className="k">Max retries</div><div>{job?.max_retries ?? 0}</div>
          <div className="k">Next run</div><div className="muted">{job?.next_run ? fmtTime(job.next_run) : '—'}</div>
        </div>
      </div>

      {stuck.length > 0 && (
        <>
          <div className="row">
            <h2 style={{ color: 'var(--red)', margin: 0 }}>⛔ Stuck items ({stuck.length})</h2>
            <div className="spacer" />
            <button className="btn" onClick={unstickAll}>↻ Unstick all</button>
          </div>
          <p className="sub">These gave up after exhausting their retries and will NOT be reprocessed until you unstick them.</p>
          <div className="panel" style={{ borderColor: 'var(--red)' }}>
            <table>
              <thead>
                <tr><th>Item</th><th>Attempts</th><th>Reason</th><th></th></tr>
              </thead>
              <tbody>
                {stuck.map((s) => {
                  const d = s.detail ?? {};
                  const hasDebug = d.snippet || d.debugFile || d.finalUrl || d.pageTitle;
                  return (
                    <Fragment key={s.item_key}>
                      <tr>
                        <td>
                          <strong>{d.name ?? s.item_key}</strong>
                          <div className="mono muted" style={{ fontSize: 11 }}>{s.item_key}</div>
                        </td>
                        <td>{s.attempts}</td>
                        <td className="muted">{d.error ?? d.status ?? '—'}</td>
                        <td><button className="btn" onClick={() => unstick(s.item_key)}>↻ Unstick</button></td>
                      </tr>
                      {hasDebug && (
                        <tr>
                          <td colSpan={4} className="muted" style={{ fontSize: 12, paddingTop: 0, lineHeight: 1.6 }}>
                            {d.pageTitle != null && <div>page title: <span className="mono">{d.pageTitle || '(empty)'}</span>{d.httpStatus != null ? ` · HTTP ${d.httpStatus}` : ''}{d.textLength != null ? ` · ${d.textLength} chars` : ''}</div>}
                            {d.snippet && <div>page text: <span className="mono">“{d.snippet}”</span></div>}
                            {d.finalUrl && <div>final URL: <span className="mono">{d.finalUrl}</span></div>}
                            {d.debugFile && <div>saved page: <span className="mono">{d.debugFile}</span></div>}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>Run history</h2>
      <div className="panel">
        <table>
          <thead>
            <tr><th>Status</th><th>Trigger</th><th>Started</th><th>Duration</th><th>Attempt</th><th></th></tr>
          </thead>
          <tbody>
            {runs.length === 0 && <tr><td colSpan={6} className="muted">No runs yet.</td></tr>}
            {runs.map((r) => (
              <tr key={r.id}>
                <td><StatusBadge status={r.status} /></td>
                <td className="muted">{r.trigger}</td>
                <td className="muted">{fmtRelative(r.started_at)}</td>
                <td className="mono">{fmtDuration(r.duration_ms)}</td>
                <td>{r.attempt}</td>
                <td><a href={`/runs/${r.id}`}>details →</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
