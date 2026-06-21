'use client';

import { use, useState } from 'react';
import { Dag } from '../../components/Dag';
import { api } from '../../lib/api';
import { fmtDuration, fmtRelative, fmtTime, usePoll } from '../../ui';

export default function PipelineDetail({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const [busy, setBusy] = useState(false);
  const { data } = usePoll(() => api.pipeline(name), 3000, [name]);
  const p = data?.pipeline;
  const runs = p?.runs ?? [];

  async function run() {
    setBusy(true);
    try { await api.runPipeline(name); } finally { setTimeout(() => setBusy(false), 1200); }
  }
  async function toggle() { if (p) await api.togglePipeline(name, p.enabled === 0); }

  return (
    <>
      <p className="muted"><a href="/pipelines">← Pipelines</a></p>
      <div className="row">
        <h1 style={{ margin: 0 }}>{name}</h1>
        <div className="spacer" />
        <button className="btn" onClick={run} disabled={busy}>{busy ? 'Started…' : '▶ Run now'}</button>
      </div>
      <p className="sub">{p?.description}</p>

      <div className="panel" style={{ padding: 18, marginBottom: 8 }}>
        <div className="kv">
          <div className="k">Schedule</div><div className="mono">{p?.schedule ?? 'manual-only'}</div>
          <div className="k">Enabled</div>
          <div>
            <span className="toggle" onClick={toggle}>
              <input type="checkbox" checked={!!p?.enabled} readOnly /> {p?.enabled ? 'enabled' : 'disabled'} (click to toggle)
            </span>
          </div>
          <div className="k">Next run</div><div className="muted">{p?.next_run ? fmtTime(p.next_run) : '—'}</div>
          <div className="k">Stuck items</div><div style={{ color: p?.stuck ? 'var(--red)' : undefined }}>{p?.stuck ?? 0}</div>
        </div>
      </div>

      <h2>Graph</h2>
      <div className="panel">{p && <Dag members={p.jobs} />}</div>

      <h2>Runs</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Status</th><th>Trigger</th><th>Started</th><th>Duration</th><th></th></tr></thead>
          <tbody>
            {runs.length === 0 && <tr><td colSpan={5} className="muted">No runs yet.</td></tr>}
            {runs.map((r) => (
              <tr key={r.id}>
                <td><span className={`badge ${r.status}`}>{r.status}</span></td>
                <td className="muted">{r.trigger}</td>
                <td className="muted">{fmtRelative(r.started_at)}</td>
                <td className="mono">{fmtDuration(r.duration_ms)}</td>
                <td><a href={`/pipeline-runs/${r.id}`}>details →</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
