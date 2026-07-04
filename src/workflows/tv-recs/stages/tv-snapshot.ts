import type { JobContext } from '../../../core/types.js';
import { plexGet } from '../../../core/plex-client.js';
import { tvRecsConfig } from '../config.js';
import { ensureDirs, writeJsonFile } from '../lib.js';
import { buildOwnedSet, buildShowSnapshots, buildTvTasteProfile } from '../tv-shows.js';
import type { PlexShowMeta, TvSnapshotFile, TvTasteProfileFile } from '../types.js';

interface PlexAllResponse<T> {
  MediaContainer?: { Metadata?: T[] };
}

/**
 * Stage 1 — snapshot the Plex TV library by GUID. Reads the TV section's shows
 * (with GUIDs + taste metadata), builds the owned tmdbId set, and writes
 * data/out/snapshot.json + data/out/taste-profile.json. RE-SCANS FRESH every run
 * (no skip-if-done) — idempotency in later stages lives in the notify ledger.
 */
export async function runTvSnapshot(ctx: JobContext): Promise<void> {
  ensureDirs();
  const section = tvRecsConfig.tvSection;
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`tv-snapshot starting — Plex section ${section} @ ${tvRecsConfig.host || '(PLEX_HOST unset)'}`);
  ctx.log(`Output: ${tvRecsConfig.snapshotOut}`);
  ctx.log(`        ${tvRecsConfig.tasteOut}`);

  ctx.progress(10, 'fetching TV shows from Plex');
  const resp = await plexGet<PlexAllResponse<PlexShowMeta>>(
    `/library/sections/${section}/all?includeGuids=1`,
  );
  const meta = resp?.MediaContainer?.Metadata ?? [];
  ctx.log(`Fetched ${meta.length} shows from section ${section}.`);

  ctx.progress(55, 'building snapshot');
  const shows = buildShowSnapshots(meta);
  const owned = buildOwnedSet(shows);
  const withTmdb = shows.filter((s) => s.tmdbId != null).length;
  const noTmdb = shows.length - withTmdb;
  ctx.log(`Built snapshot: ${shows.length} shows · ${withTmdb} GUID-matched (owned set size ${owned.size}) · ${noTmdb} without a tmdb:// GUID.`);

  if (noTmdb > 0) {
    ctx.log(`${noTmdb} show(s) have no tmdb:// GUID — they won't contribute to recommendations.`, 'warn');
    const noGuidShows = shows.filter((s) => s.tmdbId == null);
    for (const s of noGuidShows.slice(0, 20)) {
      ctx.log(`  • "${s.title}"${s.year ? ` (${s.year})` : ''} — ratingKey ${s.ratingKey}`, 'warn');
    }
    if (noGuidShows.length > 20) {
      ctx.log(`  … and ${noGuidShows.length - 20} more without a tmdb:// GUID.`, 'warn');
    }
  }

  ctx.progress(80, 'building taste profile');
  const profile = buildTvTasteProfile(shows);
  const topGenres = Object.entries(profile.genres).sort((a, b) => b[1] - a[1]).slice(0, 5);
  ctx.log(
    `Taste profile: ${Object.keys(profile.genres).length} genres, ${Object.keys(profile.roles).length} roles, ` +
    `${Object.keys(profile.decades).length} decades, ${Object.keys(profile.countries).length} countries.`,
  );
  for (const [g, n] of topGenres) ctx.log(`  top genre — ${g}: ${n}`);

  const snap: TvSnapshotFile = { generatedAt: new Date().toISOString(), section, shows };
  writeJsonFile(tvRecsConfig.snapshotOut, snap);
  const tasteFile: TvTasteProfileFile = { generatedAt: new Date().toISOString(), profile };
  writeJsonFile(tvRecsConfig.tasteOut, tasteFile);

  // Per-item progress: log each show as it's counted.
  ctx.log('──────────────────────────────────────────────────────────');
  ctx.log(`Summary: ${shows.length} shows in Plex TV library.`);
  for (let i = 0; i < shows.length; i++) {
    const s = shows[i];
    ctx.log(
      `  [${i + 1}/${shows.length}] "${s.title}"${s.year ? ` (${s.year})` : ''} · tmdbId=${s.tmdbId ?? 'none'} · ` +
      `genres=[${s.genres.join(', ')}] · seasons=${s.seasonCount ?? '?'}`,
    );
    ctx.progress(80 + Math.round((i / shows.length) * 18), `${i + 1}/${shows.length} shows logged`);
  }

  ctx.progress(100, `${shows.length} shows snapshotted`);
  ctx.log(`Wrote ${tvRecsConfig.snapshotOut}`);
  ctx.log(`Wrote ${tvRecsConfig.tasteOut}`);
}
