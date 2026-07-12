import type { JobContext } from '../../../core/types.js';
import { plexGet } from '../../../core/plex-client.js';
import { buildMovieSnapshots, buildOwnedSet } from '../../movies/movies.js';
import type { MovieSnapshotFile, PlexMovieMeta } from '../../movies/types.js';
import { missingMoviesConfig } from '../config.js';
import { ensureDirs, writeJsonFile } from '../lib.js';

interface PlexAllResponse<T> {
  MediaContainer?: { Metadata?: T[] };
}

/**
 * Stage 1 — snapshot the Plex movie library by GUID, this workflow's OWN copy
 * (separate from `movie-recommendations`'s `movie-snapshot`, mirroring
 * `plex-tv-snapshot`). Reads the section's movies (with GUIDs), builds the owned
 * tmdbId set, and writes data/out/snapshot.json ONLY — no taste-profile.json,
 * since `franchise-gaps` (the only downstream consumer here) never reads one.
 * RE-SCANS FRESH every run (no skip-if-done) — the workflow's ledger lives only
 * in the notify stage.
 */
export async function runSnapshot(ctx: JobContext): Promise<void> {
  ensureDirs();
  const section = missingMoviesConfig.movieSection;
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`plex-movie-snapshot starting — Plex section ${section} @ ${missingMoviesConfig.host || '(PLEX_HOST unset)'}`);

  ctx.progress(10, 'fetching movies');
  const resp = await plexGet<PlexAllResponse<PlexMovieMeta>>(
    `/library/sections/${section}/all?includeGuids=1`,
  );
  const meta = resp?.MediaContainer?.Metadata ?? [];
  ctx.log(`Fetched ${meta.length} movies from section ${section}.`);

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

  ctx.progress(100, `${movies.length} movies snapshotted`);
  ctx.log(`Wrote ${missingMoviesConfig.snapshotOut}`);
}
