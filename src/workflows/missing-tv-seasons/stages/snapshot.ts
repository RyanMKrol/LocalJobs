import type { JobContext } from '../../../core/types.js';
import { callService } from '../../../core/services.js';
import { plexGet } from '../../../core/plex-client.js';
import { markWorkItem } from '../../../db/store.js';
import { plexConfig } from '../config.js';
import { ensureDirs, writeJsonFile } from '../lib.js';
import { buildShowSnapshots } from '../plex.js';
import type { PlexEpisodeMeta, PlexShow, PlexShowMeta, SnapshotFile } from '../types.js';

interface PlexAllResponse<T> {
  MediaContainer?: { Metadata?: T[] };
}

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
    markWorkItem('plex-tv-snapshot', snapshotItemKey(s), 'success', {
      detail: {
        name: s.title,
        tmdbId: s.tmdbId,
        highestOwnedSeason: s.highestOwnedSeason,
      },
    });
  }
}

export interface SnapshotOpts {
  /**
   * Injectable low-level Plex GET (tests) — swaps in for the real `plexGet`,
   * still routed through `callService('plex', ...)` so the 3-hour response-cache
   * dedup (T477) can be exercised without a live Plex call. Defaults to the real
   * `plexGet`.
   */
  fetchPlex?: <T>(path: string) => Promise<T>;
}

/**
 * Stage 1 — snapshot the Plex TV library by GUID. Reads the section's shows (with
 * GUIDs + ratingKey) and the flat episode list, computes each show's highest
 * owned regular season, and writes data/out/snapshot.json. RE-SCANS FRESH every
 * run (no skip-if-done) — the workflow's ledger lives only in the notify stage.
 */
export async function runSnapshot(ctx: JobContext, opts: SnapshotOpts = {}): Promise<void> {
  ensureDirs();
  const doPlexGet = opts.fetchPlex ?? plexGet;
  const section = plexConfig.tvSection;
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`plex-tv-snapshot starting — Plex section ${section} @ ${plexConfig.host || '(PLEX_HOST unset)'}`);

  ctx.progress(5, 'fetching shows');
  const showsPath = `/library/sections/${section}/all?includeGuids=1`;
  const showsResp = await callService('plex', () => doPlexGet<PlexAllResponse<PlexShowMeta>>(showsPath), {
    cacheKey: `plex:${showsPath}`,
  });
  const showsMeta = showsResp?.MediaContainer?.Metadata ?? [];
  ctx.log(`Fetched ${showsMeta.length} shows from section ${section}.`);

  ctx.progress(40, 'fetching episodes');
  const epsPath = `/library/sections/${section}/all?type=4`;
  const epsResp = await callService('plex', () => doPlexGet<PlexAllResponse<PlexEpisodeMeta>>(epsPath), {
    cacheKey: `plex:${epsPath}`,
  });
  const epsMeta = epsResp?.MediaContainer?.Metadata ?? [];
  ctx.log(`Fetched ${epsMeta.length} episodes (flat read, type=4).`);

  ctx.progress(75, 'computing owned seasons');
  const shows = buildShowSnapshots(showsMeta, epsMeta);

  const withTmdb = shows.filter((s) => s.tmdbId != null).length;
  const noTmdb = shows.length - withTmdb;
  ctx.log(`Built snapshot: ${shows.length} shows · ${withTmdb} GUID-matched · ${noTmdb} without a tmdb:// GUID.`);
  // Narrate a few of the richest entries so the run page tells the story.
  for (const s of [...shows].sort((a, b) => b.highestOwnedSeason - a.highestOwnedSeason).slice(0, 5)) {
    ctx.log(`  e.g. "${s.title}"${s.year ? ` (${s.year})` : ''} — owned up to S${s.highestOwnedSeason}, tmdb=${s.tmdbId ?? '—'}`);
  }
  if (noTmdb > 0) ctx.log(`${noTmdb} show(s) have no tmdb:// GUID — they'll be flagged "unverifiable" downstream (never guessed).`, 'warn');

  const out: SnapshotFile = { generatedAt: new Date().toISOString(), section, shows };
  writeJsonFile(plexConfig.snapshotOut, out);

  // Record each show in the ledger for dashboard Input/Output visibility.
  recordSnapshotLedger(shows);

  ctx.progress(100, `${shows.length} shows snapshotted`);
  ctx.log(`Wrote ${plexConfig.snapshotOut}`);
}
