'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';
import { CopyLogsButton, ProgressBar, StatusBadge, WorkflowRunBackLink, exitCodeLabel, fmtDuration, fmtTime, usePoll } from '../../ui';

type LevelFilter = 'all' | 'info' | 'warn' | 'error';

export default function RunDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [filter, setFilter] = useState<LevelFilter>('all');
  const { data, error } = usePoll(() => api.run(id), 1000, [id]);
  const run = data?.run;
  const logs = data?.logs ?? [];

  // Fetch the parent workflow run to get its name for the back link.
  const { data: wfRunData } = usePoll(
    () => run?.workflow_run_id ? api.workflowRun(run.workflow_run_id) : Promise.resolve(null),
    5000,
    [run?.workflow_run_id],
  );
  const wfRun = wfRunData?.run;

  // Static field (a job's description rarely changes) — a slow poll is enough.
  const { data: jobData } = usePoll(
    () => run?.job_name ? api.job(run.job_name) : Promise.resolve(null),
    30000,
    [run?.job_name],
  );

  const counts = {
    info: logs.filter((l) => l.level === 'info').length,
    warn: logs.filter((l) => l.level === 'warn').length,
    error: logs.filter((l) => l.level === 'error').length,
  };
  const shownLogs = logs.filter((l) => filter === 'all' || l.level === filter);

  return (
    <>
      <WorkflowRunBackLink
        workflowRunId={run?.workflow_run_id}
        workflowName={wfRun?.workflow_name}
        fallback={run ? { href: `/jobs/${run.job_name}`, label: run.job_name } : { href: '/', label: 'back' }}
      />
      {error && <p className="muted">⚠ {error}</p>}
      {run && (
        <>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <h1 style={{ margin: 0 }}>{run.job_name}</h1>
                <StatusBadge status={run.status} />
              </div>
            </div>
            <div className="spacer" />
            <span className="muted mono">{run.id}</span>
          </div>

          {jobData?.job?.description && (
            <p className="sub" style={{ margin: '4px 0 16px' }}>{jobData.job.description}</p>
          )}

          <div style={{ margin: '16px 0' }}>
            <ProgressBar pct={run.status === 'success' ? 100 : run.progress} done={run.status !== 'running'} />
            <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
              {run.progress}%
            </div>
          </div>

          <div className="panel" style={{ padding: 18, marginBottom: 20 }}>
            <div className="kv">
              <div className="k">Job</div><div><Link href={`/jobs/${run.job_name}`}>{run.job_name}</Link></div>
              <div className="k">Trigger</div><div>{run.trigger}</div>
              <div className="k">Started</div><div>{fmtTime(run.started_at)}</div>
              <div className="k">Finished</div><div>{fmtTime(run.finished_at)}</div>
              <div className="k">Duration</div><div className="mono">{fmtDuration(run.duration_ms)}</div>
              <div className="k">Exit code</div><div className="mono">
                {run.exit_code != null
                  ? `${exitCodeLabel(run.exit_code)} (${run.exit_code})`
                  : ['success', 'failed', 'timeout', 'cancelled', 'skipped', 'partial'].includes(run.status)
                  ? exitCodeLabel(null)
                  : '—'}
              </div>
              {run.error && <><div className="k">Error</div><div className="mono" style={{ color: 'var(--red)' }}>{run.error.split('\n')[0]}</div></>}
            </div>
          </div>

          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <h2 style={{ margin: '28px 0 12px' }}>Logs</h2>
            <div className="row" style={{ gap: 6, marginBottom: 12 }}>
              <CopyLogsButton logs={logs} />
              {(['all', 'info', 'warn', 'error'] as LevelFilter[]).map((lvl) => {
                const n = lvl === 'all' ? logs.length : counts[lvl];
                return (
                  <button
                    key={lvl}
                    className={`btn ${filter === lvl ? '' : 'secondary'}`}
                    style={{ padding: '4px 11px', textTransform: 'capitalize' }}
                    onClick={() => setFilter(lvl)}
                  >
                    {lvl} ({n})
                  </button>
                );
              })}
            </div>
          </div>
          <div className="logs">
            {shownLogs.length === 0 && (
              <span className="muted">
                {logs.length === 0 ? 'No log output.' : `No ${filter} logs.`}
              </span>
            )}
            {shownLogs.map((l) => (
              <div key={l.id} className={`lvl-${l.level}`}>
                <span className="ts">{l.ts.split(' ')[1] ?? l.ts}</span>{l.message}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
