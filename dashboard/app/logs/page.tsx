'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { GlobalLogLine } from '../lib/api';
import { fmtTime, usePoll } from '../ui';

const LEVELS = ['info', 'warn', 'error'] as const;
type Level = typeof LEVELS[number];

const WINDOW_OPTIONS = [
  { hours: 24, label: '24h' },
  { hours: 24 * 7, label: '7d' },
] as const;

export default function LogsPage() {
  const [levels, setLevels] = useState<Level[]>([]);
  const [scopeType, setScopeType] = useState<'all' | 'job' | 'workflow'>('all');
  const [scopeValue, setScopeValue] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [windowHours, setWindowHours] = useState<number>(24);
  const [lines, setLines] = useState<GlobalLogLine[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Debounce the free-text search box before it feeds into the poll query.
  useEffect(() => {
    const id = setTimeout(() => setQ(searchInput.trim()), 400);
    return () => clearTimeout(id);
  }, [searchInput]);

  const { data: jobsData } = usePoll(() => api.jobs(), 30000);
  const { data: workflowsData } = usePoll(() => api.workflows(), 30000);
  const jobNames = (jobsData?.jobs ?? []).map((j) => j.name);
  const workflowNames = (workflowsData?.workflows ?? []).map((w) => w.name);

  const params = {
    level: levels.length > 0 ? levels.join(',') : undefined,
    job: scopeType === 'job' && scopeValue ? scopeValue : undefined,
    workflow: scopeType === 'workflow' && scopeValue ? scopeValue : undefined,
    q: q || undefined,
    windowHours,
  };

  const { data, error } = usePoll(
    () => api.globalLogs(params),
    5000,
    [levels.join(','), scopeType, scopeValue, q, windowHours],
  );

  // Reset the accumulated list whenever the filters (not pagination) change.
  useEffect(() => {
    setLines(data?.logs ?? []);
    setNextCursor(data?.nextCursor ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levels.join(','), scopeType, scopeValue, q, windowHours]);

  // Merge in fresh newest-first data on each poll tick without discarding
  // anything already loaded via "Load more".
  useEffect(() => {
    if (!data) return;
    setLines((prev) => {
      const seen = new Set(prev.map((l) => `${l.source}:${l.id}`));
      const fresh = data.logs.filter((l) => !seen.has(`${l.source}:${l.id}`));
      return [...fresh, ...prev];
    });
    setNextCursor((prev) => prev ?? data.nextCursor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  function toggleLevel(lvl: Level) {
    setLevels((prev) => (prev.includes(lvl) ? prev.filter((l) => l !== lvl) : [...prev, lvl]));
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const more = await api.globalLogs({ ...params, before: nextCursor });
      setLines((prev) => [...prev, ...more.logs]);
      setNextCursor(more.nextCursor);
    } catch { /* leave state as-is; next poll may recover */ }
    setLoadingMore(false);
  }

  return (
    <>
      <h1>Logs</h1>
      <p className="sub">Every job + workflow run's log lines, merged newest-first. Auto-refreshes every 5s.</p>
      {error && <p className="muted">⚠ Cannot reach the daemon API ({error}).</p>}

      <div className="panel logs-filter-panel">
        <div className="io-filter-bar">
          {LEVELS.map((lvl) => (
            <button
              key={lvl}
              type="button"
              className={`io-filter-chip${levels.includes(lvl) ? ' active' : ''}${levels.includes(lvl) ? ` io-filter-chip--${lvl === 'warn' ? 'skipped' : lvl === 'error' ? 'failed' : 'success'}` : ''}`}
              onClick={() => toggleLevel(lvl)}
            >
              {lvl}
            </button>
          ))}
          <span className="spacer" />
          {WINDOW_OPTIONS.map((w) => (
            <button
              key={w.hours}
              type="button"
              className={`io-filter-chip${windowHours === w.hours ? ' active' : ''}`}
              onClick={() => setWindowHours(w.hours)}
            >
              {w.label}
            </button>
          ))}
        </div>

        <div className="row logs-scope-row" style={{ padding: '10px 14px', gap: 10, flexWrap: 'wrap' }}>
          <select
            value={scopeType}
            onChange={(e) => { setScopeType(e.target.value as 'all' | 'job' | 'workflow'); setScopeValue(''); }}
          >
            <option value="all">All sources</option>
            <option value="job">Job…</option>
            <option value="workflow">Workflow…</option>
          </select>
          {scopeType === 'job' && (
            <select value={scopeValue} onChange={(e) => setScopeValue(e.target.value)}>
              <option value="">Any job</option>
              {jobNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
          {scopeType === 'workflow' && (
            <select value={scopeValue} onChange={(e) => setScopeValue(e.target.value)}>
              <option value="">Any workflow</option>
              {workflowNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
          <input
            type="text"
            placeholder="Search message text…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            style={{ minWidth: 220, flex: '1 1 220px' }}
          />
        </div>
      </div>

      <div className="logs" style={{ marginTop: 14 }}>
        {lines.length === 0 && <span className="muted">No log lines match the current filters.</span>}
        {lines.map((l) => {
          const href = l.runId ? `/runs/${l.runId}` : l.workflowRunId ? `/workflow-runs/${l.workflowRunId}` : null;
          const sourceLabel = l.source === 'job' ? l.jobName : l.workflowName;
          return (
            <div key={`${l.source}:${l.id}`} className={`lvl-${l.level}`}>
              <span className="ts">{fmtTime(l.ts)}</span>
              {sourceLabel && (
                href ? <a href={href} className="mono">[{sourceLabel}]</a> : <span className="mono">[{sourceLabel}]</span>
              )}
              {' '}{l.message}
            </div>
          );
        })}
      </div>

      <div className="row" style={{ justifyContent: 'center', margin: '16px 0' }}>
        <button className="btn secondary" onClick={loadMore} disabled={!nextCursor || loadingMore}>
          {loadingMore ? 'Loading…' : nextCursor ? 'Load more' : 'No more logs'}
        </button>
      </div>
    </>
  );
}
