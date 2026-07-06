'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api } from './lib/api';
import { CronBadge, ProgressBar, StatusBadge, StuckPopover, fmtDuration, fmtRelative, statusLabel, usePoll } from './ui';
import { RunButton } from './components/RunButton';

type Filter = 'running' | 'success' | 'failed' | 'cancelled' | 'stuck' | 'ignored' | null;

export default function Overview() {
  const [stuckPollTick, setStuckPollTick] = useState(0);
  const { data: stuckData } = usePoll(() => api.stuck(), 5000, [stuckPollTick]);
  const { data: ignoredData } = usePoll(() => api.ignored(), 5000);
  const { data: pipeData } = usePoll(() => api.workflows(), 3000);
  const { data: pipeRunData, error } = usePoll(() => api.recentWorkflowRuns(50), 2000);
  const stuck = stuckData?.stuck ?? [];
  const ignored = ignoredData?.ignored ?? [];
  const workflows = pipeData?.workflows ?? [];
  const workflowRuns = pipeRunData?.runs ?? [];

  const [activeFilter, setActiveFilter] = useState<Filter>(null);
  const [stuckPopoverOpen, setStuckPopoverOpen] = useState(false);

  function toggleFilter(f: Filter) {
    setActiveFilter((prev) => (prev === f ? null : f));
  }

  async function unstick(job: string, key: string) {
    try { await api.unstick(job, key); } catch { /* next poll reflects reality */ }
  }
  async function ignoreItem(job: string, key: string) {
    if (!window.confirm(`Permanently ignore "${key}"?\n\nIt will never be retried and drops off the stuck list (it moves to the Ignored tile). Manual-only — use Unstick instead if you want it retried.`)) return;
    try { await api.ignore(job, key); } catch { /* next poll reflects reality */ }
  }
  async function runWorkflow(name: string) {
    try { await api.runWorkflow(name); } catch { /* next poll reflects reality */ }
  }

  // Counts reflect WORKFLOW runs (the unit of work on this page), matching the
  // list the tiles filter — not individual job/member runs.
  const counts = {
    running: workflowRuns.filter((r) => r.status === 'running').length,
    success: workflowRuns.filter((r) => r.status === 'success').length,
    failed: workflowRuns.filter((r) => ['failed', 'partial'].includes(r.status)).length,
    cancelled: workflowRuns.filter((r) => r.status === 'cancelled').length,
  };

  // Apply filter to workflow cards and workflow runs table. The item-level
  // filters (stuck/ignored) don't map to a workflow status; 'ignored' is an
  // overview-only view, so it hides the workflow/run/stuck sections entirely.
  const visibleWorkflows = activeFilter == null ? workflows : workflows.filter((p) => {
    if (activeFilter === 'running') return p.last_run?.status === 'running';
    if (activeFilter === 'success') return p.last_run?.status === 'success';
    if (activeFilter === 'failed') return ['failed', 'partial'].includes(p.last_run?.status ?? '');
    if (activeFilter === 'cancelled') return p.last_run?.status === 'cancelled';
    if (activeFilter === 'stuck') return p.stuck > 0;
    return false; // 'ignored' — no workflow-level concept
  });

  const visibleWorkflowRuns = activeFilter == null || activeFilter === 'stuck' ? workflowRuns : workflowRuns.filter((r) => {
    if (activeFilter === 'running') return r.status === 'running';
    if (activeFilter === 'success') return r.status === 'success';
    if (activeFilter === 'failed') return ['failed', 'partial'].includes(r.status);
    if (activeFilter === 'cancelled') return r.status === 'cancelled';
    return false; // 'ignored' — overview-only view, hide runs
  });

  const visibleStuck = activeFilter == null || activeFilter === 'stuck' ? stuck : [];
  // Ignored items live ONLY here, and ONLY when the Ignored tile is active.
  const visibleIgnored = activeFilter === 'ignored' ? ignored : [];

  const filterLabels: Record<NonNullable<Filter>, string> = {
    running: 'Running',
    success: 'Succeeded',
    failed: 'Failed',
    cancelled: 'Cancelled',
    stuck: 'Stuck items',
    ignored: 'Ignored items',
  };

  return (
    <>
      {stuckPopoverOpen && (
        <StuckPopover
          items={stuck}
          onClose={() => setStuckPopoverOpen(false)}
          onAction={() => setStuckPollTick((t) => t + 1)}
        />
      )}
      <h1>Overview</h1>
      <p className="sub">Recent workflow activity. Auto-refreshes every 2s.</p>
      {error && <p className="muted">⚠ Cannot reach daemon at the API ({error}). Is it running?</p>}

      {activeFilter && (
        <p className="muted" style={{ marginBottom: 8 }}>
          Filtering: <strong>{filterLabels[activeFilter]}</strong>{' '}
          <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => setActiveFilter(null)}>× clear</button>
        </p>
      )}

      <div className="statcards">
        <button
          className={`statcard${activeFilter === 'running' ? ' active' : ''}`}
          onClick={() => toggleFilter('running')}
          title="Click to filter by running"
        >
          <div className="n">{counts.running}</div><div className="l">Running</div>
        </button>
        <button
          className={`statcard${activeFilter === 'success' ? ' active' : ''}`}
          onClick={() => toggleFilter('success')}
          title="Click to filter by succeeded"
        >
          <div className="n" style={{ color: 'var(--green)' }}>{counts.success}</div><div className="l">Succeeded</div>
        </button>
        <button
          className={`statcard${activeFilter === 'failed' ? ' active' : ''}`}
          onClick={() => toggleFilter('failed')}
          title="Click to filter by failed"
        >
          <div className="n" style={{ color: 'var(--red)' }}>{counts.failed}</div><div className="l">Failed runs</div>
        </button>
        <button
          className={`statcard${activeFilter === 'cancelled' ? ' active' : ''}`}
          onClick={() => toggleFilter('cancelled')}
          title="Click to filter by cancelled"
        >
          <div className="n" style={{ color: counts.cancelled ? 'var(--muted)' : undefined }}>{counts.cancelled}</div><div className="l">Cancelled</div>
        </button>
        <button
          className={`statcard${activeFilter === 'stuck' ? ' active' : ''}`}
          onClick={() => { if (stuck.length > 0) setStuckPopoverOpen(true); else toggleFilter('stuck'); }}
          title={stuck.length > 0 ? 'Click to manage stuck items' : 'Click to filter by stuck'}
        >
          <div className="n" style={{ color: stuck.length ? 'var(--red)' : undefined }}>{stuck.length}</div><div className="l">Stuck items</div>
        </button>
        <button
          className={`statcard${activeFilter === 'ignored' ? ' active' : ''}`}
          onClick={() => toggleFilter('ignored')}
          title="Click to show manually-ignored items"
        >
          <div className="n" style={{ color: ignored.length ? 'var(--muted)' : undefined }}>{ignored.length}</div><div className="l">Ignored</div>
        </button>
      </div>

      {activeFilter === 'ignored' && ignored.length > 0 && (
        <>
          <h2>🚫 Ignored items <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>— manually parked, never retried, not counted as stuck</span></h2>
          <div className="panel">
            <table>
              <thead>
                <tr><th>Item</th><th>Job</th><th>Attempts</th><th>Reason</th><th>When</th></tr>
              </thead>
              <tbody>
                {visibleIgnored.map((s) => (
                  <tr key={`${s.job_name}:${s.item_key}`}>
                    <td>{s.detail?.name ?? <span className="mono">{s.item_key}</span>}</td>
                    <td><Link href={`/jobs/${s.job_name}`}>{s.job_name}</Link></td>
                    <td>{s.attempts}</td>
                    <td className="muted">{s.detail?.error ?? s.detail?.status ?? '—'}{s.detail?.pageTitle ? ` · title="${s.detail.pageTitle}"` : ''}</td>
                    <td className="muted">{fmtRelative(s.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {activeFilter !== 'ignored' && (<>
      <h2>Workflows</h2>
      <div className="grid cards" style={{ marginBottom: 8 }}>
        {visibleWorkflows.length === 0 && (
          <div className="panel" style={{ padding: 16 }}>
            <span className="muted">{activeFilter ? 'No workflows match the current filter.' : 'No workflows yet.'}</span>
          </div>
        )}
        {visibleWorkflows.map((p) => (
          <div key={p.name} className="panel" style={{ padding: 16 }}>
            <Link href={`/workflows/${p.name}`}><strong>{p.name}</strong></Link>
            {p.last_run && (
              <div style={{ marginTop: 4 }}>
                <Link href={`/workflow-runs/${p.last_run.id}`} style={{ textDecoration: 'none' }}>
                  <span className={`badge ${p.last_run.status}`}>{statusLabel(p.last_run.status)}</span>
                </Link>
              </div>
            )}
            <div className="muted" style={{ fontSize: 12, margin: '6px 0' }}>
              {p.jobs.length} stages · {p.schedule
                ? <CronBadge expr={p.schedule} />
                : 'manual'}
            </div>
            {p.last_run?.status === 'running' && <ProgressBar pct={p.last_run.progress} />}
            <div style={{ marginTop: 10 }}>
              <RunButton variant="secondary" isRunning={false} label="▶ Run" onClick={() => runWorkflow(p.name)} />
            </div>
          </div>
        ))}
      </div>

      {stuck.length > 0 && (
      <>
      <h2>
        ⛔ Stuck items <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>— gave up, will NOT retry</span>
        {' '}
        <button className="btn secondary" style={{ fontSize: 12, padding: '2px 10px', verticalAlign: 'middle' }} onClick={() => setStuckPopoverOpen(true)}>Manage all…</button>
      </h2>
      <div className="panel" style={{ borderColor: 'var(--red)' }}>
        <table>
          <thead>
            <tr><th>Item</th><th>Job</th><th>Attempts</th><th>Reason</th><th>When</th><th></th></tr>
          </thead>
          <tbody>
            {visibleStuck.length === 0 && (
              <tr><td colSpan={6} className="muted">Stuck items hidden by current filter.</td></tr>
            )}
            {visibleStuck.map((s) => (
              <tr key={`${s.job_name}:${s.item_key}`}>
                <td>{s.detail?.name ?? <span className="mono">{s.item_key}</span>}</td>
                <td><Link href={`/jobs/${s.job_name}`}>{s.job_name}</Link></td>
                <td>{s.attempts}</td>
                <td className="muted">{s.detail?.error ?? s.detail?.status ?? '—'}{s.detail?.pageTitle ? ` · title="${s.detail.pageTitle}"` : ''}</td>
                <td className="muted">{fmtRelative(s.updated_at)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn" onClick={() => unstick(s.job_name, s.item_key)}>↻ Unstick</button>{' '}
                  <button className="btn" onClick={() => ignoreItem(s.job_name, s.item_key)} title="Permanently ignore this item — never retried, drops off the stuck list">✕ Ignore</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>
      )}

      <h2>Recent workflow runs</h2>
      <div className="panel">
        <div className="recent-runs-scroll">
          <table>
            <thead>
              <tr><th>Workflow</th><th>Status</th><th>Trigger</th><th>Started</th><th>Duration</th><th></th></tr>
            </thead>
            <tbody>
              {visibleWorkflowRuns.length === 0 && (
                <tr><td colSpan={6} className="muted">
                  {activeFilter && workflowRuns.length > 0
                    ? 'No workflow runs match the current filter.'
                    : 'No workflow runs yet — trigger one from a workflow card above.'}
                </td></tr>
              )}
              {visibleWorkflowRuns.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/workflows/${r.workflow_name}`}>{r.workflow_name}</Link></td>
                  <td><span className={`badge ${r.status}`}>{statusLabel(r.status)}</span></td>
                  <td className="muted">{r.trigger}</td>
                  <td className="muted">{fmtRelative(r.started_at)}</td>
                  <td className="mono">{fmtDuration(r.duration_ms)}</td>
                  <td><Link href={`/workflow-runs/${r.id}`}>details →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </>)}
    </>
  );
}
