'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { DagFlow } from '../../components/DagFlow';
import { GroupedManager, type GroupedManagerConfig } from '../../components/GroupedManager';
import { Pill } from '../../components/Pill';
import { RecsManager, type RecsManagerConfig } from '../../components/RecsManager';
import { RunButton } from '../../components/RunButton';
import { WorkflowOutputSection } from '../../components/WorkflowOutputSection';
import { api, type MissingSeason, type MissingSeasons, type MovieGap, type MovieGaps, type MovieRec, type MovieRecs, type TvRec, type TvRecs, type Workflow } from '../../lib/api';
import { CronBadge, StatusBadge, fmtAbsolute, fmtDuration, fmtRelative, fmtTime, usePoll } from '../../ui';

/** `idempotency_note` is a manifest-owned field (T613) surfaced by the API but not yet on the `Workflow` type. */
type WorkflowWithIdempotencyNote = Workflow & { idempotency_note?: string };

/** Workflow names that show the Missing seasons section. */
const MISSING_SEASONS_WORKFLOWS = new Set(['missing-tv-seasons']);

/**
 * Workflows that have a dedicated, workflow-specific output manager
 * (a RecsManager or GroupedManager config below). The generic
 * WorkflowOutputSection is rendered for all OTHER workflows (T205).
 */
const WORKFLOWS_WITH_SPECIFIC_MANAGERS = new Set([
  'movie-recommendations',
  'missing-tv-seasons',
  'tv-recommendations',
  'missing-movies',
]);

/** Config for the movie-recommendations RecsManager (T584, replacing MovieRecsManager). */
const MOVIE_RECS_CONFIG: RecsManagerConfig<MovieRec> = {
  heading: { tag: 'h3', text: 'Recommendations' },
  noun: 'film',
  tmdbPath: 'movie',
  fetchData: () => api.movieRecs(),
  ignore: (tmdbId) => api.ignoreMovieRec(tmdbId),
  unignore: (tmdbId) => api.unignoreMovieRec(tmdbId),
  unignoreBulk: (tmdbIds) => api.unignoreMovieRecBulk(tmdbIds),
};

/** Config for the tv-recommendations RecsManager (T584, replacing TvRecsManager). */
const TV_RECS_CONFIG: RecsManagerConfig<TvRec> = {
  heading: { tag: 'h2', text: 'Output' },
  noun: 'show',
  tmdbPath: 'tv',
  fetchData: () => api.tvRecs(),
  ignore: (tmdbId) => api.ignoreTvRec(tmdbId),
  unignore: (tmdbId) => api.unignoreTvRec(tmdbId),
  unignoreBulk: (tmdbIds) => api.unignoreTvRecBulk(tmdbIds),
};

/** Group gaps by collection name, sorted by name; films sorted by year then title. */
function groupByCollection(gaps: MovieGap[]): [string, MovieGap[]][] {
  const map = new Map<string, MovieGap[]>();
  for (const g of gaps) {
    const arr = map.get(g.collectionName) ?? [];
    arr.push(g);
    map.set(g.collectionName, arr);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, films]) => [
      name,
      films.sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || a.title.localeCompare(b.title)),
    ] as [string, MovieGap[]]);
}

/** Config for the missing-movies GroupedManager (T584, replacing MovieGapsManager). */
const MOVIE_GAPS_CONFIG: GroupedManagerConfig<MovieGap, string, MovieGaps> = {
  heading: { tag: 'h3', text: 'Franchise gaps' },
  description: (
    <>
      Films you own <em>some but not all</em> of, detected via the TMDB Collections API. Every
      factual gap is shown (no quality filter); the TMDB rating is context only. Ignore a gap to
      suppress it from future reports and notifications.
    </>
  ),
  fetchData: () => api.movieGaps(),
  getGeneratedAt: (data) => data.generatedAt,
  getItems: (data) => data.gaps,
  isIgnored: (g) => g.ignored,
  itemKey: (g) => String(g.tmdbId),
  groupBy: groupByCollection,
  renderGroupLabel: (cname, _films, data, ignoredSide) => {
    const example = !ignoredSide ? data.collectionExamples?.[cname] : undefined;
    return (
      <>
        {cname}
        {example && (
          <span className="muted" style={{ fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
            You own: {example.title}{example.year != null ? ` (${example.year})` : ''}
          </span>
        )}
      </>
    );
  },
  activeColumns: ['Film', 'Year', 'TMDB'],
  ignoredColumns: ['Film', 'Year'],
  renderCells: (g, ignoredSide) => (
    <>
      <td>
        <a
          href={`https://www.themoviedb.org/movie/${g.tmdbId}`}
          target="_blank"
          rel="noreferrer"
          style={ignoredSide ? undefined : { color: 'var(--text)' }}
        >
          {g.title}
        </a>
        {!ignoredSide && g.notified && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>notified</span>}
      </td>
      <td>{g.year ?? '—'}</td>
      {!ignoredSide && <td>{g.tmdbRating != null ? g.tmdbRating.toFixed(1) : '—'}</td>}
    </>
  ),
  emptyBeforeGenerated: {
    inPanel: true,
    text: 'No audit has run yet. This workflow runs monthly (or run it manually) — the detected franchise gaps will appear here.',
  },
  summaryLine: (data, active, activeGroups, ignored) => (
    <>
      {active.length} active gap{active.length === 1 ? '' : 's'} across{' '}
      {activeGroups.length} collection
      {activeGroups.length === 1 ? '' : 's'} · {data.collectionsChecked} collections
      checked{ignored.length ? ` · ${ignored.length} ignored` : ''}.
    </>
  ),
  ignoredSubtitle: 'Suppressed by you — never reported or notified, even though you don\'t own them.',
  ignoreItem: (g) => api.ignoreMovieGap(g.tmdbId),
  unignoreItem: (g) => api.unignoreMovieGap(g.tmdbId),
  ignoreGroup: (_cname, films) => api.ignoreMovieGapBulk(films.map((f) => f.tmdbId)),
  unignoreGroup: (_cname, films) => api.unignoreMovieGapBulk(films.map((f) => f.tmdbId)),
};

/** Group missing-season rows by show (tmdbId), preserving input order. */
function groupByShow(seasons: MissingSeason[]): [number, MissingSeason[]][] {
  const map = new Map<number, MissingSeason[]>();
  for (const s of seasons) {
    const arr = map.get(s.tmdbId) ?? [];
    arr.push(s);
    map.set(s.tmdbId, arr);
  }
  return [...map.values()]
    .sort((a, b) => a[0].title.localeCompare(b[0].title))
    .map((items) => [items[0].tmdbId, items.sort((a, b) => a.season - b.season)] as [number, MissingSeason[]]);
}

/** Config for the missing-tv-seasons GroupedManager (T584, replacing MissingSeasonsManager). */
const MISSING_SEASONS_CONFIG: GroupedManagerConfig<MissingSeason, number, MissingSeasons> = {
  heading: { tag: 'h2', text: 'Output' },
  description: (
    <>
      Seasons you don&apos;t own that are completely aired on TMDB, detected by comparing your
      Plex library against TMDB. Ignore a season to suppress it from future reports and
      notifications.
    </>
  ),
  fetchData: () => api.missingSeasons(),
  getGeneratedAt: (data) => data.generatedAt,
  getItems: (data) => data.shows,
  isIgnored: (s) => s.ignored,
  itemKey: (s) => `${s.tmdbId}:${s.season}`,
  groupBy: groupByShow,
  renderGroupLabel: (_tmdbId, items) => {
    const meta = items[0];
    return (
      <>
        <a href={`https://www.themoviedb.org/tv/${meta.tmdbId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--text)' }}>
          {meta.title}
        </a>
        {meta.year ? <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>({meta.year})</span> : null}
      </>
    );
  },
  activeColumns: ['Season'],
  ignoredColumns: ['Season'],
  renderCells: (s, ignoredSide) => (
    <td>
      Season {s.season}
      {!ignoredSide && s.notified && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>notified</span>}
    </td>
  ),
  emptyBeforeGenerated: {
    inPanel: false,
    text: 'No check has run yet. Run the workflow manually — the detected missing seasons will appear here.',
  },
  summaryLine: (_data, active, activeGroups, ignored) => (
    <>
      {active.length} active missing season{active.length === 1 ? '' : 's'} across{' '}
      {activeGroups.length} show{activeGroups.length === 1 ? '' : 's'}
      {ignored.length ? ` · ${ignored.length} ignored` : ''}.
    </>
  ),
  noActiveMessage: 'No active missing seasons — all clear!',
  ignoredSubtitle: 'Suppressed by you — never reported or notified again.',
  ignoreItem: (s) => api.missingSeasonsIgnore(s.tmdbId, s.season),
  unignoreItem: (s) => api.unignoreMissingSeason(s.tmdbId, s.season),
  ignoreGroup: (_tmdbId, items) => api.missingSeasonsIgnoreBulk(items.map((s) => ({ tmdbId: s.tmdbId, season: s.season }))),
  unignoreGroup: (_tmdbId, items) => api.missingSeasonsUnignoreBulk(items.map((s) => ({ tmdbId: s.tmdbId, season: s.season }))),
};

export default function WorkflowDetail({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState('');
  const busyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (busyTimerRef.current) clearTimeout(busyTimerRef.current); }, []);
  const { data, error } = usePoll(() => api.workflow(name), 3000, [name]);
  const p = data?.workflow as WorkflowWithIdempotencyNote | undefined;
  const runs = p?.runs ?? [];

  // Reset (clear output data) state.
  const [resetting, setResetting] = useState(false);
  const [resetResult, setResetResult] = useState<string | null>(null);
  const [resetErr, setResetErr] = useState<string | null>(null);

  async function resetOutput() {
    const msg =
      `Clear all output data for "${name}"?\n\n` +
      `This permanently deletes:\n` +
      `  • Work item ledger (re-runs from scratch next time)\n` +
      `  • All run history and logs\n` +
      `  • Output files (data/out/**)\n\n` +
      `This will NOT touch:\n` +
      `  • Input data (data/raw/**)\n` +
      `  • Workflow settings (schedule, concurrency, enabled)\n\n` +
      `The workflow will re-process everything from scratch on the next run.`;
    if (!confirm(msg)) return;
    setResetting(true);
    setResetResult(null);
    setResetErr(null);
    try {
      const r = await api.resetWorkflowOutput(name);
      setResetResult(`Cleared: ${r.itemsDeleted} ledger rows, ${r.runsDeleted} job runs, ${r.wfRunsDeleted} workflow runs, ${r.filesRemoved} output file entries.`);
    } catch (e) {
      setResetErr(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  }

  // Inline schedule editor (T135).
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [scheduleDraft, setScheduleDraft] = useState('');
  const [scheduleErr, setScheduleErr] = useState<string | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);

  function startEditSchedule() {
    setScheduleDraft(p?.schedule ?? '');
    setScheduleErr(null);
    setEditingSchedule(true);
  }
  function cancelEditSchedule() {
    setEditingSchedule(false);
    setScheduleErr(null);
  }
  async function saveSchedule() {
    setSavingSchedule(true);
    setScheduleErr(null);
    try {
      await api.updateWorkflowSchedule(name, scheduleDraft);
      // The 3s poll refetches the workflow, so the CronBadge + Next run update on
      // the next tick; close the editor immediately on success.
      setEditingSchedule(false);
    } catch (e) {
      setScheduleErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingSchedule(false);
    }
  }

  // Inline max-concurrency editor (T169/T201) — same affordance as the schedule editor.
  // T201 adds an "Unlimited" toggle: when on, persists sentinel 0 (no cap); when off, the
  // number input applies. effective_max_concurrency === 0 means unlimited.
  const [editingConc, setEditingConc] = useState(false);
  const [concDraft, setConcDraft] = useState('');
  const [concUnlimited, setConcUnlimited] = useState(false);
  const [concErr, setConcErr] = useState<string | null>(null);
  const [savingConc, setSavingConc] = useState(false);

  function startEditConc() {
    const eff = p?.effective_max_concurrency ?? 0;
    const isUnlim = eff === 0;
    setConcUnlimited(isUnlim);
    setConcDraft(isUnlim ? '' : String(eff));
    setConcErr(null);
    setEditingConc(true);
  }
  function cancelEditConc() {
    setEditingConc(false);
    setConcErr(null);
  }
  async function saveConc() {
    setSavingConc(true);
    setConcErr(null);
    try {
      await api.updateWorkflowConcurrency(name, concUnlimited ? 0 : Number(concDraft));
      // The 3s poll refetches, so the displayed value updates on the next tick.
      setEditingConc(false);
    } catch (e) {
      setConcErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingConc(false);
    }
  }

  async function run() {
    setBusy(true);
    try { await api.runWorkflow(name, limit ? Number(limit) : undefined); } finally { busyTimerRef.current = setTimeout(() => setBusy(false), 1200); }
  }
  async function toggle() { if (p) await api.toggleWorkflow(name, p.enabled === 0); }
  async function toggleNotify() { if (p) await api.updateWorkflowNotify(name, !p.effective_notify_enabled); }
  async function toggleCertified() { if (p) await api.updateWorkflowCertified(name, !p.certified); }

  return (
    <>
      <p className="muted"><Link href="/workflows">← Workflows</Link></p>
      {error && <p className="muted">⚠ Cannot reach the daemon API ({error}).</p>}
      <div className="row" style={{ gap: 20 }}>
        <h1 style={{ margin: 0 }}>{name}</h1>
        {p?.certified ? <Pill kind="certified">🏅 Certified</Pill> : null}
        {p?.starting ? <Pill kind="starting" title="Run accepted — awaiting the root stage's input scan before the run row appears">Starting…</Pill> : null}
        <div className="spacer" />
        {p?.limitable && (
          <div className="run-limit-control">
            <label htmlFor="run-limit" className="run-limit-label">Limit</label>
            <input
              id="run-limit"
              className="mono limit-input"
              type="number"
              min={1}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="all"
              title="Limit this run to N originating inputs (blank = all). All fan-out of the selected inputs runs."
            />
          </div>
        )}
        <RunButton isRunning={p?.starting || p?.last_run?.status === 'running'} busy={busy} onClick={run} runningLabel={p?.starting ? 'Starting…' : 'Running…'} />
      </div>
      <p className="sub wf-desc">{p?.description}</p>

      <div className="panel" style={{ padding: 18, marginBottom: 8 }}>
        <div className="kv">
          <div className="k">Schedule</div>
          <div>
            {editingSchedule ? (
              <div className="schedule-edit">
                <input
                  className="mono schedule-input"
                  type="text"
                  value={scheduleDraft}
                  onChange={(e) => setScheduleDraft(e.target.value)}
                  placeholder="cron (blank = manual-only)"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') saveSchedule(); if (e.key === 'Escape') cancelEditSchedule(); }}
                />
                <button className="btn btn-sm" onClick={saveSchedule} disabled={savingSchedule}>
                  {savingSchedule ? 'Saving…' : 'Save'}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={cancelEditSchedule} disabled={savingSchedule}>Cancel</button>
                {scheduleErr && <span className="schedule-err">{scheduleErr}</span>}
              </div>
            ) : (
              <span className="schedule-view">
                <span className="mono" style={{ whiteSpace: 'nowrap' }}>
                  {p?.schedule ? <CronBadge expr={p.schedule} /> : 'manual-only'}
                </span>
                <button type="button" className="btn-link schedule-edit-link" onClick={startEditSchedule}>Edit</button>
              </span>
            )}
          </div>
          <div className="k">Enabled</div>
          <div>
            <span
              className="toggle"
              role="switch"
              tabIndex={0}
              aria-checked={!!p?.enabled}
              onClick={toggle}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
            >
              <input type="checkbox" checked={!!p?.enabled} readOnly tabIndex={-1} /> {p?.enabled ? 'enabled' : 'disabled'} (click to toggle)
            </span>
          </div>
          <div className="k">Max concurrency</div>
          <div>
            {editingConc ? (
              <div className="schedule-edit">
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={concUnlimited}
                    onChange={(e) => setConcUnlimited(e.target.checked)}
                  />
                  Unlimited
                </label>
                <input
                  className="mono schedule-input"
                  type="number"
                  min={1}
                  step={1}
                  value={concDraft}
                  onChange={(e) => setConcDraft(e.target.value)}
                  placeholder="≥ 1"
                  disabled={concUnlimited}
                  autoFocus={!concUnlimited}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveConc(); if (e.key === 'Escape') cancelEditConc(); }}
                />
                <button className="btn btn-sm" onClick={saveConc} disabled={savingConc}>
                  {savingConc ? 'Saving…' : 'Save'}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={cancelEditConc} disabled={savingConc}>Cancel</button>
                {concErr && <span className="schedule-err">{concErr}</span>}
              </div>
            ) : (
              <span className="schedule-view">
                <span className="mono" style={{ whiteSpace: 'nowrap' }}>
                  {p?.effective_max_concurrency === 0 ? 'Unlimited' : (p?.effective_max_concurrency ?? '—')}
                  {p?.max_concurrency_overridden ? '' : ' (default)'}
                </span>
                <button type="button" className="btn-link schedule-edit-link" onClick={startEditConc}>Edit</button>
              </span>
            )}
          </div>
          <div className="k">Notifications</div>
          <div>
            <span
              className="toggle"
              role="switch"
              tabIndex={0}
              aria-checked={!!p?.effective_notify_enabled}
              onClick={toggleNotify}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleNotify(); } }}
            >
              <input type="checkbox" checked={!!p?.effective_notify_enabled} readOnly tabIndex={-1} /> {p?.effective_notify_enabled ? 'notifications on' : 'notifications off'} (click to toggle)
            </span>
          </div>
          <div className="k">Certified</div>
          <div>
            <span
              className="toggle"
              role="switch"
              tabIndex={0}
              aria-checked={!!p?.certified}
              onClick={toggleCertified}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCertified(); } }}
            >
              <input type="checkbox" checked={!!p?.certified} readOnly tabIndex={-1} /> {p?.certified ? 'certified ✓' : 'not certified'} (click to {p?.certified ? 'un-certify' : 'certify'})
            </span>
          </div>
          <div className="k">Next run</div><div className="muted">{p?.next_run ? fmtTime(p.next_run) : '—'}</div>
          <div className="k">Stuck items</div><div style={{ color: p?.stuck ? 'var(--red)' : undefined }}>{p?.stuck ?? 0}</div>
        </div>
      </div>

      {p?.idempotency_note ? <p className="sub">{p.idempotency_note}</p> : null}

      <h2>Graph</h2>
      <div className="panel dag-panel">{p && <DagFlow members={p.jobs} structuralGates={p.gates} workflowName={name} from={`/workflows/${name}`} />}</div>

      <h2>Runs</h2>
      <div className="panel">
        <table>
          <thead><tr><th>Status</th><th>Trigger</th><th>Started</th><th>Duration</th><th></th></tr></thead>
          <tbody>
            {runs.length === 0 && <tr><td colSpan={5} className="muted">No runs yet.</td></tr>}
            {runs.map((r) => (
              <tr key={r.id}>
                <td><StatusBadge status={r.status} /></td>
                <td className="muted">{r.trigger}</td>
                <td className="muted">{fmtAbsolute(r.started_at)}</td>
                <td className="mono">{fmtDuration(r.duration_ms)}</td>
                <td><Link href={`/workflow-runs/${r.id}`}>details →</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {name === 'movie-recommendations' && (
        <>
          <h2>Output</h2>
          <RecsManager<MovieRec> config={MOVIE_RECS_CONFIG} />
        </>
      )}
      {name === 'missing-movies' && (
        <>
          <h2>Output</h2>
          <GroupedManager<MovieGap, string, MovieGaps> config={MOVIE_GAPS_CONFIG} />
        </>
      )}
      {MISSING_SEASONS_WORKFLOWS.has(name) && <GroupedManager<MissingSeason, number, MissingSeasons> config={MISSING_SEASONS_CONFIG} />}
      {name === 'tv-recommendations' && <RecsManager<TvRec> config={TV_RECS_CONFIG} />}
      {!WORKFLOWS_WITH_SPECIFIC_MANAGERS.has(name) && <WorkflowOutputSection workflowName={name} />}

      <h2>Danger zone</h2>
      <div className="panel" style={{ borderLeft: '3px solid var(--red)', padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <strong>Clear output data</strong>
            <p className="muted" style={{ fontSize: 13, margin: '4px 0 0' }}>
              Deletes run history, the work item ledger, and output files (<code>data/out/**</code>).
              Input data (<code>data/raw</code>), settings, and service limits are preserved.
              The workflow re-processes everything from scratch on the next run.
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
            <button
              className="btn btn-danger"
              onClick={resetOutput}
              disabled={resetting || p?.last_run?.status === 'running'}
              title={p?.last_run?.status === 'running' ? 'Cannot reset while a run is in progress' : undefined}
            >
              {resetting ? 'Clearing…' : 'Clear output data'}
            </button>
            {resetResult && <span style={{ fontSize: 12, color: 'var(--green)' }}>{resetResult}</span>}
            {resetErr && <span style={{ fontSize: 12, color: 'var(--red)' }}>{resetErr}</span>}
          </div>
        </div>
      </div>
    </>
  );
}
