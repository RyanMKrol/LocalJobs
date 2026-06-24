'use client';

import { useState } from 'react';
import { api, type MovieGap } from '../lib/api';
import { usePoll } from '../ui';

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

export default function MovieGapsPage() {
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
    <main>
      <h1>Movie franchise gaps</h1>
      <p className="muted">
        Films you own <em>some but not all</em> of, detected via the TMDB Collections API by the{' '}
        <a href="/workflows/movies">movies</a> workflow. Every factual gap is shown (no quality
        filter); the TMDB rating is context only. Ignore a gap to suppress it from future reports
        and notifications.
      </p>

      {error && <p className="error">Failed to load: {String(error)}</p>}
      {err && <p className="error">{err}</p>}

      {data && data.generatedAt == null && (
        <div className="panel">
          <p className="muted">
            No audit has run yet. The <a href="/workflows/movies">movies</a> workflow runs monthly
            (or run it manually) — the detected franchise gaps will appear here.
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

      {groupByCollection(active).map(([name, films]) => (
        <div className="panel" key={name}>
          <h2 style={{ fontSize: 16 }}>{name}</h2>
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
                    <button onClick={() => ignore(g)} disabled={busy === g.tmdbId}>
                      {busy === g.tmdbId ? 'Ignoring…' : '✕ Ignore'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {ignored.length > 0 && (
        <div className="panel">
          <h2 style={{ fontSize: 16 }}>Ignored ({ignored.length})</h2>
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
    </main>
  );
}
