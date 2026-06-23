'use client';

import { use, useState } from 'react';
import { Dag } from '../../components/Dag';
import { api } from '../../lib/api';
import { CronBadge, fmtDuration, fmtRelative, fmtTime, statusLabel, usePoll } from '../../ui';

export default function WorkflowDetail({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState('');
  const { data } = usePoll(() => api.workflow(name), 3000, [name]);
  const p = data?.workflow;
  const runs = p?.runs ?? [];

  async function run() {
    setBusy(true);
    try { await api.runWorkflow(name, limit ? Number(limit) : undefined); } finally { setTimeout(() => setBusy(false), 1200); }
  }
  async function toggle() { if (p) await api.toggleWorkflow(name, p.enabled === 0); }

  return (
    <>
      <p className="muted"><a href="/workflows">← Workflows</a></p>
      <div className="row">
        <h1 style={{ margin: 0 }}>{name}</h1>
        <div className="spacer" />
        {p?.limitable && (
          <div className="run-limit-control">
            <label htmlFor="run-limit" className="run-limit-label">Limit</label>
            <input
              id="run-limit"
              className="mono run-limit-input"
              type="number"
              min={1}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="all"
              title="Limit this run to N originating inputs (blank = all). All fan-out of the selected inputs runs."
            />
          </div>
        )}
        {p?.last_run?.status === 'running'
          ? <button className="btn" disabled title="A run is already in progress — only one run per workflow at a time">Running…</button>
          : <button className="btn" onClick={run} disabled={busy}>{busy ? 'Started…' : '▶ Run now'}</button>}
      </div>
      <p className="sub">{p?.description}</p>

      <div className="panel" style={{ padding: 18, marginBottom: 8 }}>
        <div className="kv">
          <div className="k">Schedule</div>
          <div className="mono" style={{ whiteSpace: 'nowrap' }}>
            {p?.schedule
              ? <CronBadge expr={p.schedule} />
              : 'manual-only'}
          </div>
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
      <div className="panel">{p && <Dag members={p.jobs} structuralGates={p.gates} workflowName={name} from={`/workflows/${name}`} />}</div>

      <h2>Runs</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Status</th><th>Trigger</th><th>Started</th><th>Duration</th><th></th></tr></thead>
          <tbody>
            {runs.length === 0 && <tr><td colSpan={5} className="muted">No runs yet.</td></tr>}
            {runs.map((r) => (
              <tr key={r.id}>
                <td><span className={`badge ${r.status}`}>{statusLabel(r.status)}</span></td>
                <td className="muted">{r.trigger}</td>
                <td className="muted">{fmtRelative(r.started_at)}</td>
                <td className="mono">{fmtDuration(r.duration_ms)}</td>
                <td><a href={`/workflow-runs/${r.id}`}>details →</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
