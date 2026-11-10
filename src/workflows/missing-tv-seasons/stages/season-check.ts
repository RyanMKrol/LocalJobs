import { existsSync, readFileSync } from 'node:fs';
import { QuotaExceededError, callService } from '../../../core/services.js';
import type { JobContext } from '../../../engine/index.js';
import { tmdbGet } from '../../../core/plex-client.js';
import { plexConfig } from '../config.js';
import { ensureDirs, writeJsonFile } from '../lib.js';
import {
  candidateSeasons,
  evaluateShow,
  highestAiredSeason,
} from '../tmdb.js';
import type {
  ErroredShow,
  MissingSeasonsFile,
  PlexShow,
  ShowMissingSeasons,
  SnapshotFile,
  TmdbEpisode,
  TmdbSeasonDetail,
  TmdbSeriesDetail,
  UnverifiableShow,
} from '../types.js';

/**
 * Stage 2 — check TMDB for complete seasons the owner is missing. For each
 * snapshotted show WITH a tmdbId: read `/tv/{id}` for status + seasons, find the
 * highest AIRED regular season, and for each candidate season (owned+1..aired)
 * read `/tv/{id}/season/{N}` and keep it ONLY if the season is COMPLETE (every
 * episode aired). ENDED/CANCELED shows are NOT skipped (revivals). A show with no
 * tmdbId is flagged "unverifiable", never guessed. TMDB calls route through the
 * shared rate-limited `tmdb` service. RE-CHECKS FRESH every run.
 */
export interface SeasonCheckOpts {
  /** The snapshot to check (the stage's `snapshot` input). Defaults to the configured path. */
  snapshotFile?: string;
  /** Where to write the result (the stage's `missing` output). Defaults to the configured path. */
  missingFile?: string;
}

export async function runSeasonCheck(ctx: JobContext, opts: SeasonCheckOpts = {}): Promise<void> {
  ensureDirs();
  const snapshotFile = opts.snapshotFile ?? plexConfig.snapshotOut;
  const missingFile = opts.missingFile ?? plexConfig.missingOut;
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('tmdb-season-check starting');
  if (!existsSync(snapshotFile)) {
    throw new Error(`snapshot.json not found — run plex-tv-snapshot first (${snapshotFile}).`);
  }
  const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8')) as SnapshotFile;
  const shows = snapshot.shows ?? [];
  ctx.log(`Loaded ${shows.length} shows from snapshot.`);

  const now = new Date();
  const actionable: ShowMissingSeasons[] = [];
  const unverifiable: UnverifiableShow[] = [];
  const errors: ErroredShow[] = [];
  let checked = 0;
  let tmdbCalls = 0;
  let failed = 0;
  let unverifiableFailedCount = 0;

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    ctx.progress((i / Math.max(shows.length, 1)) * 100, `checked ${checked}/${shows.length}`);

    if (show.tmdbId == null) {
      unverifiable.push({ title: show.title, ratingKey: show.ratingKey });
      ctx.log(`  ? "${show.title}" has no tmdb:// GUID: unverifiable, never guessed`, 'warn');
      unverifiableFailedCount++;
      continue;
    }

    try {
      const detail = await callService('tmdb', () => tmdbGet<TmdbSeriesDetail>(`/tv/${show.tmdbId}`), {
        cacheKey: `tmdb:/tv/${show.tmdbId}`,
      });
      tmdbCalls++;
      const seasons = detail.seasons ?? [];
      const aired = highestAiredSeason(seasons, now);
      const cands = candidateSeasons(show.highestOwnedSeason, aired);

      const seasonEpisodes = new Map<number, TmdbEpisode[]>();
      for (const n of cands) {
        const sdata = await callService(
          'tmdb',
          () => tmdbGet<TmdbSeasonDetail>(`/tv/${show.tmdbId}/season/${n}`),
          { cacheKey: `tmdb:/tv/${show.tmdbId}/season/${n}` },
        );
        tmdbCalls++;
        seasonEpisodes.set(n, sdata.episodes ?? []);
      }

      const result = evaluateShow(show as PlexShow & { tmdbId: number }, detail, seasonEpisodes, now);
      checked++;
      if (result) {
        actionable.push(result);
        ctx.log(`  ✓ "${show.title}" [${result.tmdbStatus}] — own S${show.highestOwnedSeason}, aired S${aired} → missing complete ${result.completeMissingSeasons.map((s) => `S${s}`).join(', ')}`);
      }
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        ctx.log(`tmdb ${err.window} cap reached (${err.used}/${err.cap}) — stopping gracefully; next run resumes.`, 'warn');
        break;
      }
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      // One bad show must not fail the whole audit — log + skip it.
      ctx.log(`  ✗ "${show.title}" (tmdb=${show.tmdbId}) — ${msg}`, 'warn');
      errors.push({ title: show.title, tmdbId: show.tmdbId, error: msg });
      failed++;
    }
  }

  const out: MissingSeasonsFile = { generatedAt: new Date().toISOString(), shows: actionable, unverifiable, errors };
  writeJsonFile(missingFile, out);

  ctx.progress(100, `${actionable.length} actionable, ${unverifiable.length} unverifiable`);
  ctx.log('');
  ctx.log('═══════════════ SEASON-CHECK SUMMARY ═══════════════');
  ctx.log(`Checked ${checked} GUID-matched shows · ${tmdbCalls} TMDB calls.`);
  ctx.log(`Actionable (complete missing season(s)): ${actionable.length}`);
  for (const s of actionable) {
    ctx.log(`  • ${s.title} — missing ${s.completeMissingSeasons.map((n) => `S${n}`).join(', ')} [${s.tmdbStatus}]`);
  }
  ctx.log(`Unverifiable (no tmdb:// GUID): ${unverifiable.length}`);
  ctx.log(`Wrote ${missingFile}`);
  ctx.log('═════════════════════════════════════════════════════');

  const totalFailed = failed + unverifiableFailedCount;
  if (totalFailed > 0) {
    throw new Error(`${totalFailed} show(s) failed this run (${unverifiableFailedCount} unverifiable + ${failed} TMDB errors) — see logs above`);
  }
}
