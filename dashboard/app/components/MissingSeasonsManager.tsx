'use client';

import { Fragment } from 'react';
import { api, type MissingSeason } from '../lib/api';
import { usePoll } from '../ui';
import { IgnoredSection } from './IgnoredSection';
import { useAction } from './useAction';

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
export function MissingSeasonsManager() {
  const { data, error, refetch } = usePoll(() => api.missingSeasons(), 5000);
  const item = useAction<string>(refetch);
  const show = useAction<number>(refetch);
  const ignoredShow = useAction<number>(refetch);

  const all = data?.shows ?? [];
  const active = all.filter((s) => !s.ignored);
  const ignored = all.filter((s) => s.ignored);

  const ignore = (s: MissingSeason) =>
    item.run(`${s.tmdbId}:${s.season}`, () => api.missingSeasonsIgnore(s.tmdbId, s.season));
  const unignore = (s: MissingSeason) =>
    item.run(`${s.tmdbId}:${s.season}`, () => api.unignoreMissingSeason(s.tmdbId, s.season));
  const ignoreShow = (meta: MissingSeason, nums: number[]) =>
    show.run(meta.tmdbId, () => api.missingSeasonsIgnoreBulk(nums.map((season) => ({ tmdbId: meta.tmdbId, season }))));
  const unignoreShow = (meta: MissingSeason, nums: number[]) =>
    ignoredShow.run(meta.tmdbId, () => api.missingSeasonsUnignoreBulk(nums.map((season) => ({ tmdbId: meta.tmdbId, season }))));

  const err = item.err || show.err || ignoredShow.err;

  return (
    <>
      <h2>Output</h2>
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

      {active.length > 0 && (
        <div className="panel">
          <table>
            <thead>
              <tr><th>Season</th><th></th></tr>
            </thead>
            <tbody>
              {groupByShow(active).map(([meta, nums]) => (
                <Fragment key={meta.tmdbId}>
                  <tr className="table-group-header">
                    <td colSpan={2}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                        <span>
                          <a href={`https://www.themoviedb.org/tv/${meta.tmdbId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--text)' }}>
                            {meta.title}
                          </a>
                          {meta.year ? <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>({meta.year})</span> : null}
                        </span>
                        {nums.length > 1 && (
                          <button
                            className="btn btn-sm"
                            onClick={() => ignoreShow(meta, nums)}
                            disabled={show.busy === meta.tmdbId}
                            style={{ flexShrink: 0 }}
                          >
                            {show.busy === meta.tmdbId ? 'Ignoring…' : '✕ Ignore all'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {nums.map((season) => {
                    const row = all.find((s) => s.tmdbId === meta.tmdbId && s.season === season)!;
                    const key = `${meta.tmdbId}:${season}`;
                    return (
                      <tr key={`${meta.tmdbId}-${season}`}>
                        <td>
                          Season {season}
                          {row.notified && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>notified</span>}
                        </td>
                        <td>
                          <button className="btn btn-sm" onClick={() => ignore(row)} disabled={item.busy === key}>
                            {item.busy === key ? 'Ignoring…' : '✕ Ignore'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {active.length === 0 && data?.generatedAt != null && (
        <p className="muted" style={{ fontSize: 13 }}>No active missing seasons — all clear!</p>
      )}

      {ignored.length > 0 && (
        <IgnoredSection count={ignored.length} subtitle="Suppressed by you — never reported or notified again.">
          <table>
            <thead>
              <tr><th>Season</th><th></th></tr>
            </thead>
            <tbody>
              {groupByShow(ignored).map(([meta, nums]) => (
                <Fragment key={meta.tmdbId}>
                  <tr className="table-group-header">
                    <td colSpan={2}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                        <span>
                          <a href={`https://www.themoviedb.org/tv/${meta.tmdbId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--text)' }}>
                            {meta.title}
                          </a>
                          {meta.year ? <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>({meta.year})</span> : null}
                        </span>
                        {nums.length > 1 && (
                          <button
                            className="btn btn-sm"
                            onClick={() => unignoreShow(meta, nums)}
                            disabled={ignoredShow.busy === meta.tmdbId}
                            style={{ flexShrink: 0 }}
                          >
                            {ignoredShow.busy === meta.tmdbId ? 'Un-ignoring…' : '↺ Un-ignore all'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {nums.map((season) => {
                    const row = ignored.find((s) => s.tmdbId === meta.tmdbId && s.season === season)!;
                    const key = `${meta.tmdbId}:${season}`;
                    return (
                      <tr key={key} className="muted">
                        <td>Season {season}</td>
                        <td>
                          <button className="btn btn-sm" onClick={() => unignore(row)} disabled={item.busy === key}>
                            {item.busy === key ? 'Un-ignoring…' : '↺ Un-ignore'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </IgnoredSection>
      )}
    </>
  );
}
