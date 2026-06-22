'use client';

import { api } from '../lib/api';
import { fmtRelative, fmtTime, statusLabel, usePoll } from '../ui';

export default function Workflows() {
  const { data, error } = usePoll(() => api.workflows(), 3000);
  const workflows = data?.workflows ?? [];

  async function run(name: string) {
    try { await api.runWorkflow(name); } catch { /* next poll reflects reality */ }
  }

  return (
    <>
      <h1>Workflows</h1>
      <p className="sub">DAGs of jobs the framework runs as a unit. Auto-refreshes every 3s.</p>
      {error && <p className="muted">⚠ Cannot reach the daemon API ({error}).</p>}
      <div className="panel">
        <table>
          <thead>
            <tr><th>Workflow</th><th style={{ textAlign: 'center' }}>Stages</th><th style={{ textAlign: 'center' }}>Schedule</th><th>Last run</th><th>Next</th><th></th></tr>
          </thead>
          <tbody>
            {workflows.length === 0 && (
              <tr><td colSpan={6} className="muted">No workflows yet — drop a <span className="mono">*.workflow.ts</span> in src/jobs.</td></tr>
            )}
            {workflows.map((p) => (
              <tr key={p.name}>
                <td>
                  <a href={`/workflows/${p.name}`}><strong>{p.name}</strong></a>
                  {p.stuck > 0 && <span style={{ color: 'var(--red)', fontSize: 12, marginLeft: 8 }}>⛔ {p.stuck} stuck</span>}
                  <div className="muted" style={{ fontSize: 12 }}>{p.description}</div>
                </td>
                <td className="muted" style={{ textAlign: 'center' }}>{p.jobs.length}</td>
                <td className="mono" style={{ whiteSpace: 'nowrap', textAlign: 'center' }}>{p.schedule ?? <span className="muted">manual</span>}{p.enabled ? '' : ' (off)'}</td>
                <td>
                  {p.last_run
                    ? <span style={{ whiteSpace: 'nowrap' }}><span className={`badge ${p.last_run.status}`}>{statusLabel(p.last_run.status)}</span> <span className="muted">{fmtRelative(p.last_run.started_at)}</span></span>
                    : <span className="muted">never</span>}
                </td>
                <td className="muted">{p.next_run ? fmtTime(p.next_run) : '—'}</td>
                <td><button className="btn" onClick={() => run(p.name)}>▶ Run</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
