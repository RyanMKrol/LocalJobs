import type { JobContext } from '../../../core/types.js';
import { fetchSectionMetadata } from '../../../core/plex-client.js';
import { dayKey } from '../../../core/dates.js';
import { markWorkItem } from '../../../db/store.js';
import { moviesConfig } from '../config.js';
import { ensureDirs, writeJsonFile } from '../lib.js';
import { buildMovieSnapshots, buildOwnedSet, buildTasteProfile } from '../movies.js';
import type { MovieSnapshotFile, PlexMovieMeta, TasteProfileFile } from '../types.js';

/** The DAG member (job) name this stage records its ledger row under. */
export const SNAPSHOT_JOB = 'movie-snapshot';

export interface SnapshotOpts {
  /** Injectable Plex fetch (tests). Defaults to the real callService('plex', plexGet). */
  fetchMeta?: () => Promise<PlexMovieMeta[]>;
  /**
   * Injectable low-level Plex GET (tests) — swaps in for the real `plexGet` used
   * by the DEFAULT `fetchMeta`, still routed through `callService('plex', ...)`
   * so the 3-hour response-cache dedup (T477) can be exercised without a live
   * Plex call. Ignored when `fetchMeta` is also given. Defaults to the real
   * `plexGet`.
   */
  plexFetch?: <T>(path: string) => Promise<T>;
  /** Injectable clock (tests) — drives the per-run ledger key. */
  now?: Date;
}

/**
 * Stage 1 — snapshot the Plex movie library by GUID. Reads the section's movies
 * (with GUIDs + taste metadata), builds the owned tmdbId set, and writes
 * data/out/snapshot.json + data/out/taste-profile.json. RE-SCANS FRESH every run
 * (no skip-if-done) — the notify stage's "have I recommended this?" ledger is
 * unchanged. Records ONE combined visibility row per run (keyed by the run's ISO
 * date, so a same-day manual re-run upserts the same row) so the run page's
 * Input/Output panel shows what this stage produced (T571).
 */
export async function runSnapshot(ctx: JobContext, opts: SnapshotOpts = {}): Promise<void> {
  ensureDirs();
  const now = opts.now ?? new Date();
  const section = moviesConfig.movieSection;
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`movie-snapshot starting — Plex section ${section} @ ${moviesConfig.host || '(PLEX_HOST unset)'}`);

  ctx.progress(10, 'fetching movies');
  const fetchMeta = opts.fetchMeta ?? (() =>
    fetchSectionMetadata<PlexMovieMeta>(section, { query: '?includeGuids=1', fetch: opts.plexFetch }));
  const meta = await fetchMeta();
  ctx.log(`Fetched ${meta.length} movies from section ${section}.`);

  ctx.progress(55, 'building snapshot');
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

  ctx.progress(80, 'building taste profile');
  const profile = buildTasteProfile(movies);
  const topGenres = Object.entries(profile.genres).sort((a, b) => b[1] - a[1]).slice(0, 5);
  ctx.log(`Taste profile: ${Object.keys(profile.genres).length} genres, ${Object.keys(profile.directors).length} directors, ${Object.keys(profile.decades).length} decades, ${Object.keys(profile.countries).length} countries.`);
  for (const [g, n] of topGenres) ctx.log(`  top genre — ${g}: ${n}`);

  const snap: MovieSnapshotFile = { generatedAt: now.toISOString(), section, movies };
  writeJsonFile(moviesConfig.snapshotOut, snap);
  const tasteFile: TasteProfileFile = { generatedAt: now.toISOString(), profile };
  writeJsonFile(moviesConfig.tasteOut, tasteFile);

  // One combined visibility row per run (T571) — so the run page's Input/Output
  // panel shows what this stage produced. Keyed by the run's ISO date; a same-day
  // manual re-run upserts the same row. NOT a work-done ledger (this stage always
  // re-scans fresh) — purely for dashboard visibility.
  markWorkItem(SNAPSHOT_JOB, dayKey(now), 'success', {
    detail: { name: 'Movie library snapshot', movies: movies.length, path: moviesConfig.snapshotOut, format: 'json' },
  });

  ctx.progress(100, `${movies.length} movies snapshotted`);
  ctx.log(`Wrote ${moviesConfig.snapshotOut}`);
  ctx.log(`Wrote ${moviesConfig.tasteOut}`);
}
