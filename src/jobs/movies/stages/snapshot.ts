import type { JobContext } from '../../../core/types.js';
import { plexGet } from '../../plex/client.js';
import { moviesConfig } from '../config.js';
import { ensureDirs, writeJsonFile } from '../lib.js';
import { buildMovieSnapshots, buildOwnedSet, buildTasteProfile } from '../movies.js';
import type { MovieSnapshotFile, PlexMovieMeta, TasteProfileFile } from '../types.js';

interface PlexAllResponse<T> {
  MediaContainer?: { Metadata?: T[] };
}

/**
 * Stage 1 — snapshot the Plex movie library by GUID. Reads the section's movies
 * (with GUIDs + taste metadata), builds the owned tmdbId set, and writes
 * data/out/snapshot.json + data/out/taste-profile.json. RE-SCANS FRESH every run
 * (no skip-if-done) — the workflow's ledger lives only in the notify stage.
 */
export async function runSnapshot(ctx: JobContext): Promise<void> {
  ensureDirs();
  const section = moviesConfig.movieSection;
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`movie-snapshot starting — Plex section ${section} @ ${moviesConfig.host || '(PLEX_HOST unset)'}`);

  ctx.progress(10, 'fetching movies');
  const resp = await plexGet<PlexAllResponse<PlexMovieMeta>>(
    `/library/sections/${section}/all?includeGuids=1`,
  );
  const meta = resp?.MediaContainer?.Metadata ?? [];
  ctx.log(`Fetched ${meta.length} movies from section ${section}.`);

  ctx.progress(55, 'building snapshot');
  const movies = buildMovieSnapshots(meta);
  const owned = buildOwnedSet(movies);
  const withTmdb = movies.filter((m) => m.tmdbId != null).length;
  const noTmdb = movies.length - withTmdb;
  ctx.log(`Built snapshot: ${movies.length} movies · ${withTmdb} GUID-matched (owned set size ${owned.size}) · ${noTmdb} without a tmdb:// GUID.`);
  if (noTmdb > 0) ctx.log(`${noTmdb} movie(s) have no tmdb:// GUID — they can't be checked for franchise gaps (never guessed).`, 'warn');

  ctx.progress(80, 'building taste profile');
  const profile = buildTasteProfile(movies);
  const topGenres = Object.entries(profile.genres).sort((a, b) => b[1] - a[1]).slice(0, 5);
  ctx.log(`Taste profile: ${Object.keys(profile.genres).length} genres, ${Object.keys(profile.directors).length} directors, ${Object.keys(profile.decades).length} decades, ${Object.keys(profile.countries).length} countries.`);
  for (const [g, n] of topGenres) ctx.log(`  top genre — ${g}: ${n}`);

  const snap: MovieSnapshotFile = { generatedAt: new Date().toISOString(), section, movies };
  writeJsonFile(moviesConfig.snapshotOut, snap);
  const tasteFile: TasteProfileFile = { generatedAt: new Date().toISOString(), profile };
  writeJsonFile(moviesConfig.tasteOut, tasteFile);

  ctx.progress(100, `${movies.length} movies snapshotted`);
  ctx.log(`Wrote ${moviesConfig.snapshotOut}`);
  ctx.log(`Wrote ${moviesConfig.tasteOut}`);
}
