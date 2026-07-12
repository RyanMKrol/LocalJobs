import type { JobContext } from '../../../core/types.js';
import { plexGet } from '../../../core/plex-client.js';
import { missingMoviesConfig } from '../config.js';
import { ensureDirs, writeJsonFile } from '../lib.js';
import { buildMovieSnapshots } from '../../movies/movies.js';
import type { MovieSnapshotFile, PlexMovieMeta } from '../../movies/types.js';

interface PlexAllResponse<T> {
  MediaContainer?: { Metadata?: T[] };
}

/**
 * Stage 1 — snapshot the Plex movie library by GUID, for the franchise-gap
 * audit only. This is a DELIBERATE duplicate of `movie-recommendations`'s own
 * `movie-snapshot` job (T467 design decision) rather than a shared stage — own
 * job (`plex-movie-snapshot`), own `data/out/snapshot.json`, mirroring
 * `missing-tv-seasons`'s `plex-tv-snapshot` vs `tv-recommendations`'s
 * `tv-snapshot`. Deliberately SKIPS building a taste profile: `franchise-gaps`
 * never reads one (only `movie-recommendations`'s recommender branches do), so
 * building it here would be dead work. RE-SCANS FRESH every run (no
 * skip-if-done) — this workflow's ledger lives only in the notify stage.
 */
export async function runSnapshot(ctx: JobContext): Promise<void> {
  ensureDirs();
  const section = missingMoviesConfig.movieSection;
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`plex-movie-snapshot starting — Plex section ${section} @ ${missingMoviesConfig.host || '(PLEX_HOST unset)'}`);

  ctx.progress(20, 'fetching movies');
  const resp = await plexGet<PlexAllResponse<PlexMovieMeta>>(
    `/library/sections/${section}/all?includeGuids=1`,
  );
  const meta = resp?.MediaContainer?.Metadata ?? [];
  ctx.log(`Fetched ${meta.length} movies from section ${section}.`);

  ctx.progress(70, 'building snapshot');
  const movies = buildMovieSnapshots(meta);
  const withTmdb = movies.filter((m) => m.tmdbId != null).length;
  const noTmdb = movies.length - withTmdb;
  ctx.log(`Built snapshot: ${movies.length} movies · ${withTmdb} GUID-matched · ${noTmdb} without a tmdb:// GUID.`);
  if (noTmdb > 0) {
    ctx.log(`${noTmdb} movie(s) have no tmdb:// GUID — they can't be checked for franchise gaps (never guessed).`, 'warn');
  }

  const snap: MovieSnapshotFile = { generatedAt: new Date().toISOString(), section, movies };
  writeJsonFile(missingMoviesConfig.snapshotOut, snap);

  ctx.progress(100, `${movies.length} movies snapshotted`);
  ctx.log(`Wrote ${missingMoviesConfig.snapshotOut}`);
}
