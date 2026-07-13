'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api } from '../lib/api';
import type { StuckItem } from '../lib/api';
import { CronBadge, StuckPopover, fmtRelative, fmtTime, statusLabel, usePoll } from '../ui';
import type { Workflow } from '../lib/api';
import { RunButton } from '../components/RunButton';
import { Pill } from '../components/Pill';
import { CategoryTable } from '../components/CategoryTable';

/** `category` is a manifest-owned field (T292) surfaced by the API but not yet on the `Workflow` type. */
type WorkflowWithCategory = Workflow & { category?: string };

const CATEGORY_GROUPS = [
  { key: 'second-brain', label: 'Second brain' },
  { key: 'recommendations', label: 'Recommendations' },
  { key: 'regular-maintenance', label: 'Regular maintenance' },
  { key: 'uncategorized', label: 'Uncategorized' },
] as const;

export default function Workflows() {
  const { data, error } = usePoll(() => api.workflows(), 3000);
  const workflows = (data?.workflows ?? []) as WorkflowWithCategory[];
  const [openWorkflow, setOpenWorkflow] = useState<string | null>(null);
  const [popoverItems, setPopoverItems] = useState<StuckItem[]>([]);
  const [busyWorkflows, setBusyWorkflows] = useState<Set<string>>(new Set());

  async function run(name: string) {
    setBusyWorkflows((prev) => new Set(prev).add(name));
    try {
      await api.runWorkflow(name);
    } catch {
      /* next poll reflects reality */
    } finally {
      setBusyWorkflows((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
    }
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
      {workflows.length === 0 && (
        <div className="panel">
          <p className="muted">No workflows yet — drop a <span className="mono">*.workflow.ts</span> in src/workflows.</p>
        </div>
      )}
      {CATEGORY_GROUPS.map(({ key, label }) => ({
        key,
        label,
        group: workflows.filter((p) => (p.category || 'uncategorized') === key),
      }))
        .filter(({ group }) => group.length > 0)
        .map(({ key, label, group }) => {
        return (
          <CategoryTable
            key={key}
            label={label}
            columns={[
              { key: 'workflow', label: 'Workflow' },
              { key: 'enabled', label: 'Enabled', align: 'center' },
              { key: 'notifications', label: 'Notifications', align: 'center' },
              { key: 'stages', label: 'Stages', align: 'center' },
              { key: 'schedule', label: 'Schedule', align: 'center' },
              { key: 'last-run', label: 'Last run', align: 'center' },
              { key: 'next', label: 'Next' },
              { key: 'actions', label: '' },
            ]}
          >
            {group.map((p) => (
              <tr key={p.name}>
                <td>
                  <Link href={`/workflows/${p.name}`}><strong>{p.name}</strong></Link>
                  {p.certified ? <Pill kind="certified" title="Certified" style={{ marginLeft: 6 }}>🏅</Pill> : null}
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
                  <Pill kind={p.enabled ? 'on' : 'off'}>{p.enabled ? 'on' : 'off'}</Pill>
                </td>
                <td style={{ textAlign: 'center' }}>
                  <Pill kind={p.effective_notify_enabled ? 'on' : 'off'}>{p.effective_notify_enabled ? 'on' : 'off'}</Pill>
                </td>
                <td className="muted" style={{ textAlign: 'center' }}>{p.jobs.length}</td>
                <td className="mono" style={{ whiteSpace: 'nowrap', textAlign: 'center' }}>
                  {p.schedule
                    ? <CronBadge expr={p.schedule} />
                    : <span className="muted">manual</span>}

                </td>
                <td style={{ textAlign: 'center' }}>
                  {p.last_run
                    ? <span className="last-run-cell"><Link href={`/workflow-runs/${p.last_run.id}`} className={`badge ${p.last_run.status}`}>{statusLabel(p.last_run.status)}</Link><span className="muted last-run-time">{fmtRelative(p.last_run.started_at)}</span></span>
                    : <span className="muted">never</span>}
                </td>
                <td className="muted">{p.next_run ? fmtTime(p.next_run) : '—'}</td>
                <td>
                  <RunButton
                    isRunning={p.last_run?.status === 'running'}
                    busy={busyWorkflows.has(p.name)}
                    onClick={() => run(p.name)}
                    label="▶ Run"
                  />
                </td>
              </tr>
            ))}
          </CategoryTable>
        );
      })}
    </>
  );
}
