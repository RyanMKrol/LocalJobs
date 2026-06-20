'use client';

import { use } from 'react';
import { api } from '../../lib/api';
import { ProgressBar, StatusBadge, fmtDuration, fmtTime, usePoll } from '../../ui';

export default function RunDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error } = usePoll(() => api.run(id), 1000, [id]);
  const run = data?.run;
  const logs = data?.logs ?? [];

  return (
    <>
      <p className="muted">
        <a href={run ? `/jobs/${run.job_name}` : '/'}>← {run ? run.job_name : 'back'}</a>
      </p>
      {error && <p className="muted">⚠ {error}</p>}
      {run && (
        <>
          <div className="row">
            <h1 style={{ margin: 0 }}>Run</h1>
            <StatusBadge status={run.status} />
            <div className="spacer" />
            <span className="muted mono">{run.id}</span>
          </div>

          <div style={{ margin: '16px 0' }}>
            <ProgressBar pct={run.status === 'success' ? 100 : run.progress} />
            <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
              {run.progress}% {run.progress_msg && `· ${run.progress_msg}`}
            </div>
          </div>

          <div className="panel" style={{ padding: 18, marginBottom: 20 }}>
            <div className="kv">
              <div className="k">Job</div><div><a href={`/jobs/${run.job_name}`}>{run.job_name}</a></div>
              <div className="k">Trigger</div><div>{run.trigger}</div>
              <div className="k">Started</div><div>{fmtTime(run.started_at)}</div>
              <div className="k">Finished</div><div>{fmtTime(run.finished_at)}</div>
              <div className="k">Duration</div><div className="mono">{fmtDuration(run.duration_ms)}</div>
              <div className="k">Exit code</div><div className="mono">{run.exit_code ?? '—'}</div>
              {run.error && <><div className="k">Error</div><div className="mono" style={{ color: 'var(--red)' }}>{run.error.split('\n')[0]}</div></>}
            </div>
          </div>

          <h2>Logs</h2>
          <div className="logs">
            {logs.length === 0 && <span className="muted">No log output.</span>}
            {logs.map((l) => (
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
