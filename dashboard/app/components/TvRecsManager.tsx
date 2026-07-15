'use client';

import { useCallback, useState } from 'react';
import { api, type TvRec } from '../lib/api';
import { usePoll } from '../ui';
import { IgnoredSection } from './IgnoredSection';
import { type RecSortCol, sortRecs } from './recSort';
import { SortTh, type SortDir } from './SortTh';
import { useAction } from './useAction';

/**
 * Manage-outputs section for TV **recommendations**: lists the current recs with
 * a per-item Ignore control so the owner can suppress ones they're not interested
 * in. Backed by `/api/tv-recs` + `/api/tv-recs/:id/ignore`. Mirrors MovieRecsManager.
 */
export function TvRecsManager() {
  const { data, error, refetch } = usePoll(() => api.tvRecs(), 5000);
  const item = useAction<number>(refetch);
  const bulk = useAction<true>(refetch);
  const [sortCol, setSortCol] = useState<RecSortCol>('tmdb');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const all = data?.recommendations ?? [];
  const active = all.filter((r) => !r.ignored);
  const ignored = all.filter((r) => r.ignored);

  const handleSort = useCallback((col: RecSortCol) => {
    setSortDir((prev) => col === sortCol ? (prev === 'asc' ? 'desc' : 'asc') : 'desc');
    setSortCol(col);
  }, [sortCol]);

  const sortedActive = sortRecs(active, sortCol, sortDir);

  const ignore = (r: TvRec) => item.run(r.tmdbId, () => api.ignoreTvRec(r.tmdbId));
  const unignore = (r: TvRec) => item.run(r.tmdbId, () => api.unignoreTvRec(r.tmdbId));
  const unignoreAll = () => bulk.run(true, () => api.unignoreTvRecBulk(ignored.map((r) => r.tmdbId)));

  return (
    <>
      <h2>Output</h2>
      <p className="muted" style={{ fontSize: 13 }}>
        Shows recommended for you by the Claude-powered recommender branches, verified via TMDB and
        balanced across genres. A rec is ignored once you dismiss it — it won&apos;t appear in future
        digests or notifications.
      </p>

      {error && <p className="error">Failed to load: {String(error)}</p>}
      {(item.err || bulk.err) && <p className="error">{item.err || bulk.err}</p>}

      {data && data.generatedAt == null && (
        <div className="panel">
          <p className="empty-state-panel">
            No recommendations yet. Run the workflow manually — the recommended shows will appear here.
          </p>
        </div>
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
                <tr>
                  <SortTh label="Show" col="title" active={sortCol} dir={sortDir} onSort={handleSort} />
                  <SortTh label="Year" col="year" active={sortCol} dir={sortDir} onSort={handleSort} />
                  <SortTh label="Genre" col="genre" active={sortCol} dir={sortDir} onSort={handleSort} />
                  <SortTh label="Lens" col="lens" active={sortCol} dir={sortDir} onSort={handleSort} />
                  <SortTh label="TMDB" col="tmdb" active={sortCol} dir={sortDir} onSort={handleSort} />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedActive.map((r) => (
                  <tr key={r.tmdbId}>
                    <td>
                      <a href={`https://www.themoviedb.org/tv/${r.tmdbId}`} target="_blank" rel="noreferrer">
                        {r.title}
                      </a>
                      {r.notified && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>notified</span>}
                    </td>
                    <td>{r.year ?? '—'}</td>
                    <td className="muted">{r.genre}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{r.lens}</td>
                    <td>{r.tmdbRating != null ? r.tmdbRating.toFixed(1) : '—'}</td>
                    <td>
                      <button className="btn btn-sm" onClick={() => ignore(r)} disabled={item.busy === r.tmdbId}>
                        {item.busy === r.tmdbId ? 'Ignoring…' : '✕ Ignore'}
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
          <IgnoredSection
            count={ignored.length}
            subtitle="Dismissed by you — never recommended or notified again."
            action={
              <button className="btn btn-sm" onClick={unignoreAll} disabled={!!bulk.busy}>
                {bulk.busy ? 'Un-ignoring…' : '↺ Un-ignore all'}
              </button>
            }
          >
            <table>
              <thead>
                <tr><th>Show</th><th>Year</th><th>Genre</th><th></th></tr>
              </thead>
              <tbody>
                {[...ignored].sort((a, b) => a.title.localeCompare(b.title)).map((r) => (
                  <tr key={r.tmdbId} className="muted">
                    <td>
                      <a href={`https://www.themoviedb.org/tv/${r.tmdbId}`} target="_blank" rel="noreferrer">
                        {r.title}
                      </a>
                    </td>
                    <td>{r.year ?? '—'}</td>
                    <td>{r.genre}</td>
                    <td>
                      <button className="btn btn-sm" onClick={() => unignore(r)} disabled={item.busy === r.tmdbId}>
                        {item.busy === r.tmdbId ? 'Un-ignoring…' : '↺ Un-ignore'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </IgnoredSection>
        )}
      </div>
    </>
  );
}
