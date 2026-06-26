'use client';

import { use, useState } from 'react';
import { Dag } from '../../components/Dag';
import { api, type MissingSeason, type MovieGap, type MovieRec } from '../../lib/api';
import { CronBadge, fmtDuration, fmtRelative, fmtTime, statusLabel, usePoll } from '../../ui';

/** Workflow names that show the Missing seasons section. */
const MISSING_SEASONS_WORKFLOWS = new Set(['missing-tv-seasons']);

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

/**
 * Manage-outputs section for movie **recommendations**: lists the current recs
 * with a per-item Ignore control so the owner can suppress ones they're not
 * interested in. Backed by `/api/movie-recs` + `/api/movie-recs/:id/ignore`.
 * Mirrors `MovieGapsManager` but for recommendations, not franchise gaps.
 */
function MovieRecsManager() {
  const { data, error } = usePoll(() => api.movieRecs(), 5000);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const all = data?.recommendations ?? [];
  const active = all.filter((r) => !r.ignored);
  const ignored = all.filter((r) => r.ignored);

  async function ignore(r: MovieRec) {
    if (!confirm(`Ignore "${r.title}"? It will be excluded from future digests and notifications.`)) return;
    setBusy(r.tmdbId);
    setErr(null);
    try {
      await api.ignoreMovieRec(r.tmdbId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="output-section output-section-recs">
      <h2>Recommendations</h2>
      <p className="muted" style={{ fontSize: 13 }}>
        Films recommended for you by the Claude-powered recommender branches, verified via TMDB and
        balanced across genres. A rec is ignored once you dismiss it — it won&apos;t appear in future
        digests or notifications.
      </p>

      {error && <p className="error">Failed to load: {String(error)}</p>}
      {err && <p className="error">{err}</p>}

      {data && data.generatedAt == null && (
        <p className="muted" style={{ fontSize: 13 }}>
          No recommendations yet. Run the workflow manually — the recommended films will appear here.
        </p>
      )}

      {data && data.generatedAt != null && (
        <p className="muted" style={{ fontSize: 13 }}>
          {active.length} active recommendation{active.length === 1 ? '' : 's'} from{' '}
          {data.pooled} pooled suggestions{ignored.length ? ` · ${ignored.length} ignored` : ''}.
        </p>
      )}

      <div className="movie-gaps-scroll">
        {active.length > 0 && (
          <div className="panel">
            <table>
              <thead>
                <tr><th>Film</th><th>Year</th><th>Genre</th><th>Lens</th><th>TMDB</th><th></th></tr>
              </thead>
              <tbody>
                {active.map((r) => (
                  <tr key={r.tmdbId}>
                    <td>
                      <a href={`https://www.themoviedb.org/movie/${r.tmdbId}`} target="_blank" rel="noreferrer">
                        {r.title}
                      </a>
                      {r.notified && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>notified</span>}
                    </td>
                    <td>{r.year ?? '—'}</td>
                    <td className="muted">{r.genre}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{r.lens}</td>
                    <td>{r.tmdbRating != null ? r.tmdbRating.toFixed(1) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-sm" onClick={() => ignore(r)} disabled={busy === r.tmdbId}>
                        {busy === r.tmdbId ? 'Ignoring…' : '✕ Ignore'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {active.length === 0 && data?.generatedAt != null && (
          <p className="muted" style={{ fontSize: 13 }}>No active recommendations — all dismissed or not yet generated.</p>
        )}

        {ignored.length > 0 && (
          <div className="panel">
            <h3 style={{ fontSize: 15, marginTop: 0 }}>Ignored ({ignored.length})</h3>
            <p className="muted" style={{ fontSize: 13 }}>
              Dismissed by you — never recommended or notified again.
            </p>
            <table>
              <thead>
                <tr><th>Film</th><th>Year</th><th>Genre</th></tr>
              </thead>
              <tbody>
                {[...ignored].sort((a, b) => a.title.localeCompare(b.title)).map((r) => (
                  <tr key={r.tmdbId} className="muted">
                    <td>
                      <a href={`https://www.themoviedb.org/movie/${r.tmdbId}`} target="_blank" rel="noreferrer">
                        {r.title}
                      </a>
                    </td>
                    <td>{r.year ?? '—'}</td>
                    <td>{r.genre}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Manage-outputs section for the **movies** workflow: lists the current franchise
 * gaps with a per-item Ignore control so the owner can suppress ones they don't
 * want surfaced again. Backed by the existing `/api/movie-gaps` endpoints; ignoring
 * a gap drops it from future reports + notifications (`ignoreSurfacedItem`). This
 * used to be a dedicated top-level page (T145); T152 folded it into the workflow's
 * own detail page since it only manages this one workflow's outputs.
 */
function MovieGapsManager() {
  const { data, error } = usePoll(() => api.movieGaps(), 5000);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const all = data?.gaps ?? [];
  const active = all.filter((g) => !g.ignored);
  const ignored = all.filter((g) => g.ignored);

  async function ignore(g: MovieGap) {
    if (!confirm(`Ignore “${g.title}”? It will be excluded from future reports and notifications, even though you don't own it.`)) return;
    setBusy(g.tmdbId);
    setErr(null);
    try {
      await api.ignoreMovieGap(g.tmdbId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="output-section">
      <h2>Franchise gaps</h2>
      <p className="muted" style={{ fontSize: 13 }}>
        Films you own <em>some but not all</em> of, detected via the TMDB Collections API. Every
        factual gap is shown (no quality filter); the TMDB rating is context only. Ignore a gap to
        suppress it from future reports and notifications.
      </p>

      {error && <p className="error">Failed to load: {String(error)}</p>}
      {err && <p className="error">{err}</p>}

      {data && data.generatedAt == null && (
        <p className="muted" style={{ fontSize: 13 }}>
          No audit has run yet. This workflow runs monthly (or run it manually) — the detected
          franchise gaps will appear here.
        </p>
      )}

      {data && data.generatedAt != null && (
        <p className="muted" style={{ fontSize: 13 }}>
          {active.length} active gap{active.length === 1 ? '' : 's'} across{' '}
          {groupByCollection(active).length} collection
          {groupByCollection(active).length === 1 ? '' : 's'} · {data.collectionsChecked} collections
          checked{ignored.length ? ` · ${ignored.length} ignored` : ''}.
        </p>
      )}

      <div className="movie-gaps-scroll">
        {groupByCollection(active).map(([cname, films]) => {
          const example = data?.collectionExamples?.[cname];
          return (
          <div className="panel" key={cname}>
            <h3 style={{ fontSize: 15, marginTop: 0 }}>{cname}</h3>
            {example && (
              <p className="muted" style={{ fontSize: 12, marginTop: -4, marginBottom: 8 }}>
                You own: {example.title}{example.year != null ? ` (${example.year})` : ''}
              </p>
            )}
            <table>
              <thead>
                <tr><th>Film</th><th>Year</th><th>TMDB</th><th></th></tr>
              </thead>
              <tbody>
                {films.map((g) => (
                  <tr key={g.tmdbId}>
                    <td>
                      <a href={`https://www.themoviedb.org/movie/${g.tmdbId}`} target="_blank" rel="noreferrer">
                        {g.title}
                      </a>
                      {g.notified && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>notified</span>}
                    </td>
                    <td>{g.year ?? '—'}</td>
                    <td>{g.tmdbRating != null ? g.tmdbRating.toFixed(1) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-sm" onClick={() => ignore(g)} disabled={busy === g.tmdbId}>
                        {busy === g.tmdbId ? 'Ignoring…' : '✕ Ignore'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          );
        })}

        {ignored.length > 0 && (
          <div className="panel">
            <h3 style={{ fontSize: 15, marginTop: 0 }}>Ignored ({ignored.length})</h3>
            <p className="muted" style={{ fontSize: 13 }}>
              Suppressed by you — never reported or notified, even though you don&apos;t own them.
            </p>
            <table>
              <thead>
                <tr><th>Film</th><th>Collection</th><th>Year</th></tr>
              </thead>
              <tbody>
                {ignored.map((g) => (
                  <tr key={g.tmdbId} className="muted">
                    <td>
                      <a href={`https://www.themoviedb.org/movie/${g.tmdbId}`} target="_blank" rel="noreferrer">
                        {g.title}
                      </a>
                    </td>
                    <td>{g.collectionName}</td>
                    <td>{g.year ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** Group missing-season rows by show (tmdbId), preserving input order. */
function groupByShow(seasons: MissingSeason[]): [MissingSeason, number[]][] {
  const map = new Map<number, { meta: MissingSeason; nums: number[] }>();
  for (const s of seasons) {
    const entry = map.get(s.tmdbId) ?? { meta: s, nums: [] };
    entry.nums.push(s.season);
    map.set(s.tmdbId, entry);
  }
  return [...map.values()]
    .sort((a, b) => a.meta.title.localeCompare(b.meta.title))
    .map(({ meta, nums }) => [meta, nums.sort((a, b) => a - b)]);
}

/**
 * Manage-outputs section for the **plex / missing-tv-seasons** workflow: lists the
 * currently-detected complete-missing seasons with a per-item Ignore control so the
 * owner can suppress gaps they don't want surfaced again. Backed by the new
 * `/api/missing-seasons` endpoints; ignoring a season drops it from both future
 * reports and notifications (`ignoreSurfacedItem`). Mirrors `MovieGapsManager`.
 */
function MissingSeasonsManager() {
  const { data, error } = usePoll(() => api.missingSeasons(), 5000);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const all = data?.shows ?? [];
  const active = all.filter((s) => !s.ignored);
  const ignored = all.filter((s) => s.ignored);

  async function ignore(s: MissingSeason) {
    const label = `"${s.title}" S${s.season}`;
    if (!confirm(`Ignore ${label}? It will be excluded from future reports and notifications.`)) return;
    const key = `${s.tmdbId}:${s.season}`;
    setBusy(key);
    setErr(null);
    try {
      await api.missingSeasonsIgnore(s.tmdbId, s.season);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="output-section">
      <h2>Missing seasons</h2>
      <p className="muted" style={{ fontSize: 13 }}>
        Seasons you don&apos;t own that are completely aired on TMDB, detected by comparing your Plex
        library against TMDB. Ignore a season to suppress it from future reports and notifications.
      </p>

      {error && <p className="error">Failed to load: {String(error)}</p>}
      {err && <p className="error">{err}</p>}

      {data && data.generatedAt == null && (
        <p className="muted" style={{ fontSize: 13 }}>
          No check has run yet. Run the workflow manually — the detected missing seasons will appear
          here.
        </p>
      )}

      {data && data.generatedAt != null && (
        <p className="muted" style={{ fontSize: 13 }}>
          {active.length} active missing season{active.length === 1 ? '' : 's'} across{' '}
          {groupByShow(active).length} show{groupByShow(active).length === 1 ? '' : 's'}
          {ignored.length ? ` · ${ignored.length} ignored` : ''}.
        </p>
      )}

      <div className="movie-gaps-scroll">
        {groupByShow(active).map(([meta, nums]) => (
          <div className="panel" key={meta.tmdbId}>
            <h3 style={{ fontSize: 15, marginTop: 0 }}>
              <a href={`https://www.themoviedb.org/tv/${meta.tmdbId}`} target="_blank" rel="noreferrer">
                {meta.title}
              </a>
              {meta.year ? <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>({meta.year})</span> : null}
            </h3>
            <table>
              <thead>
                <tr><th>Season</th><th>TMDB status</th><th></th></tr>
              </thead>
              <tbody>
                {nums.map((season) => {
                  const row = all.find((s) => s.tmdbId === meta.tmdbId && s.season === season)!;
                  const key = `${meta.tmdbId}:${season}`;
                  return (
                    <tr key={season}>
                      <td>
                        Season {season}
                        {row.notified && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>notified</span>}
                      </td>
                      <td className="muted">{meta.tmdbStatus}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn btn-sm" onClick={() => ignore(row)} disabled={busy === key}>
                          {busy === key ? 'Ignoring…' : '✕ Ignore'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

        {active.length === 0 && data?.generatedAt != null && (
          <p className="muted" style={{ fontSize: 13 }}>No active missing seasons — all clear!</p>
        )}

        {ignored.length > 0 && (
          <div className="panel">
            <h3 style={{ fontSize: 15, marginTop: 0 }}>Ignored ({ignored.length})</h3>
            <p className="muted" style={{ fontSize: 13 }}>
              Suppressed by you — never reported or notified again.
            </p>
            <table>
              <thead>
                <tr><th>Show</th><th>Season</th><th>TMDB status</th></tr>
              </thead>
              <tbody>
                {[...ignored].sort((a, b) => a.title.localeCompare(b.title) || a.season - b.season).map((s) => (
                  <tr key={`${s.tmdbId}:${s.season}`} className="muted">
                    <td>
                      <a href={`https://www.themoviedb.org/tv/${s.tmdbId}`} target="_blank" rel="noreferrer">
                        {s.title}
                      </a>
                    </td>
                    <td>Season {s.season}</td>
                    <td>{s.tmdbStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function WorkflowDetail({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState('');
  const { data } = usePoll(() => api.workflow(name), 3000, [name]);
  const p = data?.workflow;
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
    try { await api.runWorkflow(name, limit ? Number(limit) : undefined); } finally { setTimeout(() => setBusy(false), 1200); }
  }
  async function toggle() { if (p) await api.toggleWorkflow(name, p.enabled === 0); }

  return (
    <>
      <p className="muted"><a href="/workflows">← Workflows</a></p>
      <div className="row" style={{ gap: 20 }}>
        <h1 style={{ margin: 0 }}>{name}</h1>
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
        {p?.last_run?.status === 'running'
          ? <button className="btn" disabled title="A run is already in progress — only one run per workflow at a time">Running…</button>
          : <button className="btn" onClick={run} disabled={busy}>{busy ? 'Started…' : '▶ Run now'}</button>}
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
                <span className="schedule-edit-link" onClick={startEditSchedule}>Edit</span>
              </span>
            )}
          </div>
          <div className="k">Enabled</div>
          <div>
            <span className="toggle" onClick={toggle}>
              <input type="checkbox" checked={!!p?.enabled} readOnly /> {p?.enabled ? 'enabled' : 'disabled'} (click to toggle)
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
                <span className="schedule-edit-link" onClick={startEditConc}>Edit</span>
              </span>
            )}
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

      {name === 'movie-recommendations' && <MovieRecsManager />}
      {name === 'movie-recommendations' && <MovieGapsManager />}
      {MISSING_SEASONS_WORKFLOWS.has(name) && <MissingSeasonsManager />}

      <h2>Danger zone</h2>
      <div className="panel" style={{ borderLeft: '3px solid var(--red)', padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
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
