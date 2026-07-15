'use client';

import React, { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { DagFlow } from '../../components/DagFlow';
import { StageIoPanel } from '../../components/StageIoLists';
import { api } from '../../lib/api';
import type { Run } from '../../lib/api';
import { CopyLogsButton, StatusBadge, fmtDuration, fmtRelative, usePoll } from '../../ui';

function latestByStage(members: Run[]): Run[] {
  const latest = new Map<string, Run>();
  // members arrive ordered by (started_at, rowid) — the rowid tiebreaker (T112) is
  // what makes "last write wins" correct during fast repeatUntilStable cycling,
  // where an earlier cycle's settled run and the current cycle's running run can
  // share a clock second. The final value per key is the genuinely-latest run, so
  // a stale "succeeded" never overwrites the live "running" (no status flicker).
  // Map preserves first-insertion order, so stage order is maintained.
  for (const r of members) latest.set(r.job_name, r);
  return [...latest.values()];
}

/** Every run for a stage EXCEPT the latest one, oldest-first (matches `members`'
 *  own ordering). Empty for a stage that only ran once. */
function earlierAttemptsByStage(members: Run[]): Map<string, Run[]> {
  const byJob = new Map<string, Run[]>();
  for (const r of members) {
    const list = byJob.get(r.job_name);
    if (list) list.push(r);
    else byJob.set(r.job_name, [r]);
  }
  const earlier = new Map<string, Run[]>();
  for (const [jobName, runs] of byJob) {
    if (runs.length > 1) earlier.set(jobName, runs.slice(0, -1));
  }
  return earlier;
}

export default function WorkflowRunDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [busy, setBusy] = useState(false);
  const busyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (busyTimerRef.current) clearTimeout(busyTimerRef.current); }, []);
  const [expandedStages, setExpandedStages] = useState<Set<string>>(new Set());
  const toggleExpanded = (jobName: string) => {
    setExpandedStages((prev) => {
      const next = new Set(prev);
      if (next.has(jobName)) next.delete(jobName);
      else next.add(jobName);
      return next;
    });
  };
  const { data, error } = usePoll(() => api.workflowRun(id), 2000, [id]);
  const run = data?.run;
  const members = data?.jobs ?? [];
  const logs = data?.logs ?? [];
  const gates = data?.gates ?? [];

  async function cancel() {
    setBusy(true);
    try { await api.cancelWorkflowRun(id); } catch { /* poll will reflect new status */ } finally { busyTimerRef.current = setTimeout(() => setBusy(false), 1200); }
  }

  // Fetch the workflow definition (for the DAG edges) once we know its name.
  const { data: pdata, error: pError } = usePoll(
    () => api.workflow(run?.workflow_name ?? '__none__'),
    5000,
    [run?.workflow_name],
  );
  const workflow = pdata?.workflow;

  // Latest member run per stage (members are ordered by (started_at, rowid), so the
  // last write per job is the genuinely-latest run — see latestByStage / T112).
  const statusByJob: Record<string, string> = {};
  const runIdByJob: Record<string, string> = {};
  for (const r of members) { statusByJob[r.job_name] = r.status; runIdByJob[r.job_name] = r.id; }

  const latestRuns = latestByStage(members);
  const earlierAttempts = earlierAttemptsByStage(members);

  const totalStages = workflow?.jobs.length ?? latestRuns.length;
  const completedStages = latestRuns.filter(r => r.status !== 'running').length;

  return (
    <>
      <p className="muted"><Link href={run ? `/workflows/${run.workflow_name}` : '/workflows'}>← {run?.workflow_name ?? 'workflows'}</Link></p>
      {(error || pError) && <p className="muted">⚠ Cannot reach the daemon API ({error || pError}).</p>}
      <div className="row">
        <h1 style={{ margin: 0 }}>Workflow run</h1>
        <div className="spacer" />
        {run && <StatusBadge status={run.status} />}
        {run?.run_limit != null && (
          <span className="badge queued" title="This run was limited to N originating inputs (all their fan-out ran).">
            {run.run_limit} input{run.run_limit === 1 ? '' : 's'} limit
          </span>
        )}
        {run?.status === 'running' && (
          <button className="btn btn-danger" onClick={cancel} disabled={busy}>
            {busy ? 'Cancelling…' : '✕ Cancel'}
          </button>
        )}
      </div>
      <p className="sub">{run ? `${completedStages} of ${totalStages} stages` : ''}{run ? ` · ${run.progress}%` : ''}{run?.duration_ms != null ? ` · ${fmtDuration(run.duration_ms)}` : ''}</p>

      {workflow && (
        <div className="panel dag-panel" style={{ marginBottom: 16 }}>
          <DagFlow members={workflow.jobs} statusByJob={statusByJob} runIdByJob={runIdByJob} gates={gates} from={`/workflow-runs/${id}`} workflowRunId={id} />
        </div>
      )}

      {workflow && <StageIoPanel runId={id} members={workflow.jobs} />}

      <h2>Member runs</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Stage</th><th>Status</th><th>When</th><th>Duration</th><th></th></tr></thead>
          <tbody>
            {members.length === 0 && <tr><td colSpan={5} className="muted">No member runs yet.</td></tr>}
            {latestRuns.map((r) => {
              const earlier = earlierAttempts.get(r.job_name) ?? [];
              const expanded = expandedStages.has(r.job_name);
              return (
                <React.Fragment key={r.id}>
                  <tr>
                    <td><strong>{r.job_name}</strong></td>
                    <td><StatusBadge status={r.status} /></td>
                    <td className="muted">{fmtRelative(r.started_at)}</td>
                    <td className="mono">{fmtDuration(r.duration_ms)}</td>
                    <td><Link href={`/runs/${r.id}`}>logs →</Link></td>
                  </tr>
                  {earlier.length > 0 && (
                    <tr>
                      <td colSpan={5}>
                        <button
                          type="button"
                          className="btn-link"
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            cursor: 'pointer',
                            color: 'inherit',
                            fontSize: '0.85em',
                          }}
                          onClick={() => toggleExpanded(r.job_name)}
                        >
                          {expanded ? '▾' : '▸'} {earlier.length} earlier attempt{earlier.length === 1 ? '' : 's'}
                        </button>
                      </td>
                    </tr>
                  )}
                  {expanded && earlier.map((e) => (
                    <tr key={e.id}>
                      <td className="muted" style={{ paddingLeft: 24 }}>{r.job_name}</td>
                      <td><StatusBadge status={e.status} /></td>
                      <td className="muted">{fmtRelative(e.started_at)}</td>
                      <td className="mono">{fmtDuration(e.duration_ms)}</td>
                      <td><Link href={`/runs/${e.id}`}>logs →</Link></td>
                    </tr>
                  ))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <h2>Framework logs</h2>
        <div style={{ marginBottom: 12 }}><CopyLogsButton logs={logs} /></div>
      </div>
      <div className="logs">
        {logs.length === 0 && <span className="muted">No framework logs yet.</span>}
        {logs.map((l) => (
          <div key={l.id} className={`lvl-${l.level}`}>
            <span className="ts">{l.ts.split(' ')[1] ?? l.ts}</span>{l.message}
          </div>
        ))}
      </div>
    </>
  );
}
