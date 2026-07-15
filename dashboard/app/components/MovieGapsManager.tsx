'use client';

import { Fragment } from 'react';
import { api, type MovieGap } from '../lib/api';
import { usePoll } from '../ui';
import { IgnoredSection } from './IgnoredSection';
import { useAction } from './useAction';

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
 * Manage-outputs section for the **movies** workflow: lists the current franchise
 * gaps with a per-item Ignore control so the owner can suppress ones they don't
 * want surfaced again. Backed by the existing `/api/movie-gaps` endpoints; ignoring
 * a gap drops it from future reports + notifications (`ignoreSurfacedItem`). This
 * used to be a dedicated top-level page (T145); T152 folded it into the workflow's
 * own detail page since it only manages this one workflow's outputs.
 */
export function MovieGapsManager() {
  const { data, error, refetch } = usePoll(() => api.movieGaps(), 5000);
  const item = useAction<number>(refetch);
  const collection = useAction<string>(refetch);
  const ignoredCollection = useAction<string>(refetch);

  const all = data?.gaps ?? [];
  const active = all.filter((g) => !g.ignored);
  const ignored = all.filter((g) => g.ignored);

  const ignore = (g: MovieGap) => item.run(g.tmdbId, () => api.ignoreMovieGap(g.tmdbId));
  const unignore = (g: MovieGap) => item.run(g.tmdbId, () => api.unignoreMovieGap(g.tmdbId));
  const ignoreCollection = (cname: string, films: MovieGap[]) =>
    collection.run(cname, () => api.ignoreMovieGapBulk(films.map((f) => f.tmdbId)));
  const unignoreCollection = (cname: string, films: MovieGap[]) =>
    ignoredCollection.run(cname, () => api.unignoreMovieGapBulk(films.map((f) => f.tmdbId)));

  const err = item.err || collection.err || ignoredCollection.err;

  return (
    <>
      <h3 style={{ fontSize: 15, marginTop: 20 }}>Franchise gaps</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        Films you own <em>some but not all</em> of, detected via the TMDB Collections API. Every
        factual gap is shown (no quality filter); the TMDB rating is context only. Ignore a gap to
        suppress it from future reports and notifications.
      </p>

      {error && <p className="error">Failed to load: {String(error)}</p>}
      {err && <p className="error">{err}</p>}

      {data && data.generatedAt == null && (
        <div className="panel">
          <p className="empty-state-panel">
            No audit has run yet. This workflow runs monthly (or run it manually) — the detected
            franchise gaps will appear here.
          </p>
        </div>
      )}

      {data && data.generatedAt != null && (
        <p className="muted" style={{ fontSize: 13 }}>
          {active.length} active gap{active.length === 1 ? '' : 's'} across{' '}
          {groupByCollection(active).length} collection
          {groupByCollection(active).length === 1 ? '' : 's'} · {data.collectionsChecked} collections
          checked{ignored.length ? ` · ${ignored.length} ignored` : ''}.
        </p>
      )}

      {active.length > 0 && (
        <div className="panel">
          <table>
            <thead>
              <tr><th>Film</th><th>Year</th><th>TMDB</th><th></th></tr>
            </thead>
            <tbody>
              {groupByCollection(active).map(([cname, films]) => {
                const example = data?.collectionExamples?.[cname];
                return (
                  <Fragment key={cname}>
                    <tr className="table-group-header">
                      <td colSpan={4}>
                        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                          <span>
                            {cname}
                            {example && (
                              <span className="muted" style={{ fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
                                You own: {example.title}{example.year != null ? ` (${example.year})` : ''}
                              </span>
                            )}
                          </span>
                          {films.length > 1 && (
                            <button
                              className="btn btn-sm"
                              onClick={() => ignoreCollection(cname, films)}
                              disabled={collection.busy === cname}
                              style={{ flexShrink: 0 }}
                            >
                              {collection.busy === cname ? 'Ignoring…' : '✕ Ignore all'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {films.map((g) => (
                      <tr key={g.tmdbId}>
                        <td>
                          <a href={`https://www.themoviedb.org/movie/${g.tmdbId}`} target="_blank" rel="noreferrer" style={{ color: 'var(--text)' }}>
                            {g.title}
                          </a>
                          {g.notified && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>notified</span>}
                        </td>
                        <td>{g.year ?? '—'}</td>
                        <td>{g.tmdbRating != null ? g.tmdbRating.toFixed(1) : '—'}</td>
                        <td>
                          <button className="btn btn-sm" onClick={() => ignore(g)} disabled={item.busy === g.tmdbId}>
                            {item.busy === g.tmdbId ? 'Ignoring…' : '✕ Ignore'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {ignored.length > 0 && (
        <IgnoredSection
          count={ignored.length}
          subtitle="Suppressed by you — never reported or notified, even though you don't own them."
        >
          <table>
            <thead>
              <tr><th>Film</th><th>Year</th><th></th></tr>
            </thead>
            <tbody>
              {groupByCollection(ignored).map(([cname, films]) => (
                <Fragment key={cname}>
                  <tr className="table-group-header">
                    <td colSpan={3}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                        <span>{cname}</span>
                        {films.length > 1 && (
                          <button
                            className="btn btn-sm"
                            onClick={() => unignoreCollection(cname, films)}
                            disabled={ignoredCollection.busy === cname}
                            style={{ flexShrink: 0 }}
                          >
                            {ignoredCollection.busy === cname ? 'Un-ignoring…' : '↺ Un-ignore all'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {films.map((g) => (
                    <tr key={g.tmdbId} className="muted">
                      <td>
                        <a href={`https://www.themoviedb.org/movie/${g.tmdbId}`} target="_blank" rel="noreferrer">
                          {g.title}
                        </a>
                      </td>
                      <td>{g.year ?? '—'}</td>
                      <td>
                        <button className="btn btn-sm" onClick={() => unignore(g)} disabled={item.busy === g.tmdbId}>
                          {item.busy === g.tmdbId ? 'Un-ignoring…' : '↺ Un-ignore'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </IgnoredSection>
      )}
    </>
  );
}
