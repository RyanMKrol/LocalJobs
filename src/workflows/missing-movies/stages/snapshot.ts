import type { JobContext } from '../../../core/types.js';
import { fetchSectionMetadata } from '../../../core/plex-client.js';
import { markWorkItem } from '../../../db/store.js';
import { buildMovieSnapshots, buildOwnedSet } from '../../movies/movies.js';
import type { MovieSnapshotFile, PlexMovie, PlexMovieMeta } from '../../movies/types.js';
import { missingMoviesConfig } from '../config.js';
import { ensureDirs, writeJsonFile } from '../lib.js';

export interface SnapshotOpts {
  /** Injectable Plex fetch (tests). Defaults to the real callService('plex', plexGet). */
  fetchMeta?: () => Promise<PlexMovieMeta[]>;
}

/** Ledger key for one movie: prefer the resolved tmdbId, else fall back to the Plex ratingKey. */
export function snapshotItemKey(movie: Pick<PlexMovie, 'tmdbId' | 'ratingKey'>): string {
  return String(movie.tmdbId ?? movie.ratingKey);
}

/**
 * Record one work_items row per movie, for dashboard Input/Output visibility (not
 * skip-if-done idempotency — this stage re-scans fresh every run regardless).
 * Extracted as its own function so it can be unit-tested without touching Plex.
 */
export function recordSnapshotLedger(movies: PlexMovie[]): void {
  for (const m of movies) {
    markWorkItem('plex-movie-snapshot', snapshotItemKey(m), 'success', {
      detail: {
        name: m.title,
        tmdbId: m.tmdbId,
        year: m.year,
      },
    });
  }
}

/**
 * Stage 1 — this workflow's OWN snapshot of the Plex movie library by GUID
 * (deliberately duplicated from `movie-recommendations`'s `movie-snapshot`, not
 * shared, so the two workflows run on independent schedules — T468). Reads the
 * section's movies (with GUIDs), builds the owned tmdbId set, and writes
 * data/out/snapshot.json. Deliberately SKIPS building a taste profile — only
 * `franchise-gaps` consumes this snapshot and it never reads taste data.
 * RE-SCANS FRESH every run (no skip-if-done) — the workflow's ledger lives only
 * in the notify stage.
 */
export async function runSnapshot(ctx: JobContext, opts: SnapshotOpts = {}): Promise<void> {
  ensureDirs();
  const section = missingMoviesConfig.movieSection;
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`plex-movie-snapshot starting — Plex section ${section} @ ${missingMoviesConfig.host || '(PLEX_HOST unset)'}`);

  ctx.progress(20, 'fetching movies');
  const fetchMeta = opts.fetchMeta ?? (() =>
    fetchSectionMetadata<PlexMovieMeta>(section, { query: '?includeGuids=1', cacheKey: null }));
  const meta = await fetchMeta();
  ctx.log(`Fetched ${meta.length} movies from section ${section}.`);

  // Fail LOUD on a 0-movie read instead of silently succeeding with an empty
  // snapshot. A populated movie library never legitimately reads empty — an empty
  // result is a transient Plex connectivity/cache anomaly. If we wrote it, the
  // downstream franchise-gaps stage would find 0 gaps and CLOBBER the last-good
  // franchise-gaps.json, wiping the dashboard's Output section even though the
  // library is unchanged. Throwing (this stage has maxRetries) preserves the last
  // good snapshot + downstream output and surfaces the failure. Mirrors the same
  // guard in missing-tv-seasons' snapshot stage.
  if (meta.length === 0) {
    throw new Error(
      `Plex section ${section} returned 0 movies — treating as a transient read failure ` +
        `(a populated movie library never legitimately reads empty). Refusing to overwrite the ` +
        `last good snapshot with an empty one. Check PLEX_HOST reachability and retry.`,
    );
  }

  ctx.progress(70, 'building snapshot');
  const movies = buildMovieSnapshots(meta);
  const owned = buildOwnedSet(movies);
  const withTmdb = movies.filter((m) => m.tmdbId != null).length;
  const noTmdb = movies.length - withTmdb;
  ctx.log(`Built snapshot: ${movies.length} movies · ${withTmdb} GUID-matched (owned set size ${owned.size}) · ${noTmdb} without a tmdb:// GUID.`);
  if (noTmdb > 0) {
    ctx.log(`${noTmdb} movie(s) have no tmdb:// GUID — they can't be checked for franchise gaps (never guessed).`, 'warn');
    const noGuidMovies = movies.filter((m) => m.tmdbId == null);
    const listed = noGuidMovies.slice(0, 20);
    for (const m of listed) ctx.log(`  • "${m.title}"${m.year ? ` (${m.year})` : ''} — ratingKey ${m.ratingKey}`, 'warn');
    if (noGuidMovies.length > 20) ctx.log(`  … and ${noGuidMovies.length - 20} more without a tmdb:// GUID.`, 'warn');
  }

  const snap: MovieSnapshotFile = { generatedAt: new Date().toISOString(), section, movies };
  writeJsonFile(missingMoviesConfig.snapshotOut, snap);

  // Record each movie in the ledger for dashboard Input/Output visibility.
  recordSnapshotLedger(movies);

  ctx.progress(100, `${movies.length} movies snapshotted`);
  ctx.log(`Wrote ${missingMoviesConfig.snapshotOut}`);
}
