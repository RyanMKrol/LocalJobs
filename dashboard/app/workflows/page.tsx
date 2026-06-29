'use client';

import { useState } from 'react';
import { api } from '../lib/api';
import type { StuckItem } from '../lib/api';
import { CronBadge, StuckPopover, fmtRelative, fmtTime, statusLabel, usePoll } from '../ui';

export default function Workflows() {
  const { data, error } = usePoll(() => api.workflows(), 3000);
  const workflows = data?.workflows ?? [];
  const [openWorkflow, setOpenWorkflow] = useState<string | null>(null);
  const [popoverItems, setPopoverItems] = useState<StuckItem[]>([]);

  async function run(name: string) {
    try { await api.runWorkflow(name); } catch { /* next poll reflects reality */ }
  }

  async function openStuck(workflowName: string) {
    try {
      const result = await api.stuckForWorkflow(workflowName);
      setPopoverItems(result.stuck);
      setOpenWorkflow(workflowName);
    } catch { /* ignore — stuck count still visible in table */ }
  }

  async function refreshStuck(workflowName: string) {
    try {
      const result = await api.stuckForWorkflow(workflowName);
      setPopoverItems(result.stuck);
    } catch { /* ignore */ }
  }

  return (
    <>
      {openWorkflow && (
        <StuckPopover
          items={popoverItems}
          scope={{ type: 'workflow', workflow: openWorkflow }}
          onClose={() => setOpenWorkflow(null)}
          onAction={() => refreshStuck(openWorkflow)}
        />
      )}
      <h1>Workflows</h1>
      <p className="sub">DAGs of jobs the framework runs as a unit. Auto-refreshes every 3s.</p>
      {error && <p className="muted">⚠ Cannot reach the daemon API ({error}).</p>}
      <div className="panel">
        <table>
          <thead>
            <tr><th>Workflow</th><th style={{ textAlign: 'center' }}>Enabled</th><th style={{ textAlign: 'center' }}>Stages</th><th style={{ textAlign: 'center' }}>Schedule</th><th style={{ textAlign: 'center' }}>Last run</th><th>Next</th><th></th></tr>
          </thead>
          <tbody>
            {workflows.length === 0 && (
              <tr><td colSpan={7} className="muted">No workflows yet — drop a <span className="mono">*.workflow.ts</span> in src/jobs.</td></tr>
            )}
            {workflows.map((p) => (
              <tr key={p.name}>
                <td>
                  <a href={`/workflows/${p.name}`}><strong>{p.name}</strong></a>
                  {p.stuck > 0 && (
                    <button
                      className="btn-link"
                      style={{ color: 'var(--red)', fontSize: 12, marginLeft: 8 }}
                      onClick={() => openStuck(p.name)}
                      title={`${p.stuck} stuck item${p.stuck === 1 ? '' : 's'} — click to manage`}
                    >
                      ⛔ {p.stuck} stuck
                    </button>
                  )}
                  <div className="muted" style={{ fontSize: 12 }}>{p.description}</div>
                </td>
                <td style={{ textAlign: 'center' }}>
                  <span className={`pill ${p.enabled ? 'on' : 'off'}`}>{p.enabled ? 'on' : 'off'}</span>
                </td>
                <td className="muted" style={{ textAlign: 'center' }}>{p.jobs.length}</td>
                <td className="mono" style={{ whiteSpace: 'nowrap', textAlign: 'center' }}>
                  {p.schedule
                    ? <CronBadge expr={p.schedule} />
                    : <span className="muted">manual</span>}

                </td>
                <td style={{ textAlign: 'center' }}>
                  {p.last_run
                    ? <span className="last-run-cell"><a href={`/workflow-runs/${p.last_run.id}`} className={`badge ${p.last_run.status}`}>{statusLabel(p.last_run.status)}</a><span className="muted last-run-time">{fmtRelative(p.last_run.started_at)}</span></span>
                    : <span className="muted">never</span>}
                </td>
                <td className="muted">{p.next_run ? fmtTime(p.next_run) : '—'}</td>
                <td>
                  {p.last_run?.status === 'running'
                    ? <button className="btn btn-run" disabled title="A run is already in progress — only one run per workflow at a time">Running…</button>
                    : <button className="btn btn-run" onClick={() => run(p.name)}>▶ Run</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
