import type { JobContext } from '../../../core/types.js';
import { fetchSectionMetadata } from '../../../core/plex-client.js';
import { markWorkItem } from '../../../db/store.js';
import { tvRecsConfig } from '../config.js';
import { ensureDirs, writeJsonFile } from '../lib.js';
import { buildOwnedSet, buildShowSnapshots, buildTvTasteProfile } from '../tv-shows.js';
import type { PlexShow, PlexShowMeta, TvSnapshotFile, TvTasteProfileFile } from '../types.js';

/** The DAG member (job) name this stage records its ledger row under. */
export const TV_SNAPSHOT_JOB = 'tv-snapshot';

/** Ledger key for one show: prefer the resolved tmdbId, else fall back to the Plex ratingKey. */
export function snapshotItemKey(show: Pick<PlexShow, 'tmdbId' | 'ratingKey'>): string {
  return String(show.tmdbId ?? show.ratingKey);
}

/**
 * Record one work_items row per show, for dashboard Input/Output visibility (not
 * skip-if-done idempotency — this stage re-scans fresh every run regardless).
 * Extracted as its own function so it can be unit-tested without touching Plex.
 */
export function recordSnapshotLedger(shows: PlexShow[]): void {
  for (const s of shows) {
    markWorkItem(TV_SNAPSHOT_JOB, snapshotItemKey(s), 'success', {
      detail: { name: s.title, tmdbId: s.tmdbId, year: s.year },
    });
  }
}

export interface TvSnapshotOpts {
  /** Injectable Plex fetch (tests). Defaults to the real callService('plex', plexGet). */
  fetchMeta?: () => Promise<PlexShowMeta[]>;
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
 * Stage 1 — snapshot the Plex TV library by GUID. Reads the TV section's shows
 * (with GUIDs + taste metadata), builds the owned tmdbId set, and writes
 * data/out/snapshot.json + data/out/taste-profile.json. RE-SCANS FRESH every run
 * (no skip-if-done) — the notify stage's "have I recommended this?" ledger is
 * unchanged. Records ONE visibility row per show (T605) so the run page's
 * Input/Output panel shows every show this stage produced.
 */
export async function runTvSnapshot(ctx: JobContext, opts: TvSnapshotOpts = {}): Promise<void> {
  ensureDirs();
  const now = opts.now ?? new Date();
  const section = tvRecsConfig.tvSection;
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`tv-snapshot starting — Plex section ${section} @ ${tvRecsConfig.host || '(PLEX_HOST unset)'}`);
  ctx.log(`Output: ${tvRecsConfig.snapshotOut}`);
  ctx.log(`        ${tvRecsConfig.tasteOut}`);

  ctx.progress(10, 'fetching TV shows from Plex');
  const fetchMeta = opts.fetchMeta ?? (() =>
    fetchSectionMetadata<PlexShowMeta>(section, { query: '?includeGuids=1', fetch: opts.plexFetch }));
  const meta = await fetchMeta();
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

  const snap: TvSnapshotFile = { generatedAt: now.toISOString(), section, shows };
  writeJsonFile(tvRecsConfig.snapshotOut, snap);
  const tasteFile: TvTasteProfileFile = { generatedAt: now.toISOString(), profile };
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

  // One visibility row per show (T605, superseding T571's single combined row) —
  // so the run page's Input/Output panel shows every show this stage produced.
  // NOT a work-done ledger (this stage always re-scans fresh) — purely for
  // dashboard visibility. Same-item re-runs (same day or otherwise) upsert in place.
  recordSnapshotLedger(shows);

  ctx.progress(100, `${shows.length} shows snapshotted`);
  ctx.log(`Wrote ${tvRecsConfig.snapshotOut}`);
  ctx.log(`Wrote ${tvRecsConfig.tasteOut}`);
}
