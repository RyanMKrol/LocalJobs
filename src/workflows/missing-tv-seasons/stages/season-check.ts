import { existsSync, readFileSync } from 'node:fs';
import { QuotaExceededError, callService } from '../../../core/services.js';
import type { JobContext } from '../../../core/types.js';
import { tmdbGet } from '../../../core/plex-client.js';
import { plexConfig } from '../config.js';
import { ensureDirs, writeJsonFile } from '../lib.js';
import {
  candidateSeasons,
  evaluateShow,
  highestAiredSeason,
} from '../tmdb.js';
import type {
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
export async function runSeasonCheck(ctx: JobContext): Promise<void> {
  ensureDirs();
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('tmdb-season-check starting');
  if (!existsSync(plexConfig.snapshotOut)) {
    throw new Error(`snapshot.json not found — run plex-tv-snapshot first (${plexConfig.snapshotOut}).`);
  }
  const snapshot = JSON.parse(readFileSync(plexConfig.snapshotOut, 'utf8')) as SnapshotFile;
  const shows = snapshot.shows ?? [];
  ctx.log(`Loaded ${shows.length} shows from snapshot.`);

  const now = new Date();
  const actionable: ShowMissingSeasons[] = [];
  const unverifiable: UnverifiableShow[] = [];
  let checked = 0;
  let tmdbCalls = 0;

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    ctx.progress((i / Math.max(shows.length, 1)) * 100, `checked ${checked}/${shows.length}`);

    if (show.tmdbId == null) {
      unverifiable.push({ title: show.title, ratingKey: show.ratingKey });
      continue;
    }

    try {
      const detail = await callService('tmdb', () => tmdbGet<TmdbSeriesDetail>(`/tv/${show.tmdbId}`));
      tmdbCalls++;
      const seasons = detail.seasons ?? [];
      const aired = highestAiredSeason(seasons, now);
      const cands = candidateSeasons(show.highestOwnedSeason, aired);

      const seasonEpisodes = new Map<number, TmdbEpisode[]>();
      for (const n of cands) {
        const sdata = await callService('tmdb', () => tmdbGet<TmdbSeasonDetail>(`/tv/${show.tmdbId}/season/${n}`));
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
    }
  }

  const out: MissingSeasonsFile = { generatedAt: new Date().toISOString(), shows: actionable, unverifiable };
  writeJsonFile(plexConfig.missingOut, out);

  ctx.progress(100, `${actionable.length} actionable, ${unverifiable.length} unverifiable`);
  ctx.log('');
  ctx.log('═══════════════ SEASON-CHECK SUMMARY ═══════════════');
  ctx.log(`Checked ${checked} GUID-matched shows · ${tmdbCalls} TMDB calls.`);
  ctx.log(`Actionable (complete missing season(s)): ${actionable.length}`);
  for (const s of actionable) {
    ctx.log(`  • ${s.title} — missing ${s.completeMissingSeasons.map((n) => `S${n}`).join(', ')} [${s.tmdbStatus}]`);
  }
  ctx.log(`Unverifiable (no tmdb:// GUID): ${unverifiable.length}`);
  ctx.log(`Wrote ${plexConfig.missingOut}`);
  ctx.log('═════════════════════════════════════════════════════');
}
