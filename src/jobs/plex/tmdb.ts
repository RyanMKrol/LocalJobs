// Pure TMDB season-math helpers (no I/O) — unit-tested in plex.test.ts.
import type {
  PlexShow,
  ShowMissingSeasons,
  TmdbEpisode,
  TmdbSeasonSummary,
  TmdbSeriesDetail,
} from './types.js';

/** YYYY-MM-DD for a Date (UTC), so ISO date strings compare lexicographically. */
export function isoDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Highest REGULAR season (season_number > 0) that has ALREADY aired — i.e. whose
 * `air_date` is on/before `now`. Season 0 (specials) and future/dateless seasons
 * are excluded. Returns 0 when nothing qualifies.
 */
export function highestAiredSeason(seasons: TmdbSeasonSummary[], now: Date): number {
  const today = isoDay(now);
  let max = 0;
  for (const s of seasons) {
    if (s.season_number > 0 && s.air_date && s.air_date <= today) {
      max = Math.max(max, s.season_number);
    }
  }
  return max;
}

/**
 * Is a season COMPLETE — every episode has an `air_date` AND the latest is on/
 * before `now`? A season still airing (any future or missing episode date) is
 * NOT complete, so we never flag a half-released season. An empty episode list is
 * not complete.
 */
export function isSeasonComplete(episodes: TmdbEpisode[], now: Date): boolean {
  if (!Array.isArray(episodes) || episodes.length === 0) return false;
  const today = isoDay(now);
  let latest = '';
  for (const e of episodes) {
    if (!e.air_date) return false; // an undated episode → still being scheduled
    if (e.air_date > latest) latest = e.air_date;
  }
  return latest <= today;
}

/** The regular seasons between owned+1 and aired (inclusive); empty if none. */
export function candidateSeasons(owned: number, aired: number): number[] {
  const out: number[] = [];
  for (let n = owned + 1; n <= aired; n++) out.push(n);
  return out;
}

/**
 * The complete seasons the owner is MISSING: each candidate season (owned+1..
 * highest-aired) kept only if its episodes form a complete (fully-aired) season.
 * `seasonEpisodes` maps a candidate season number → its TMDB episode list.
 */
export function completeMissingSeasons(
  owned: number,
  seasons: TmdbSeasonSummary[],
  seasonEpisodes: Map<number, TmdbEpisode[]>,
  now: Date,
): number[] {
  const aired = highestAiredSeason(seasons, now);
  const out: number[] = [];
  for (const n of candidateSeasons(owned, aired)) {
    if (isSeasonComplete(seasonEpisodes.get(n) ?? [], now)) out.push(n);
  }
  return out;
}

/**
 * Evaluate one show against its TMDB detail. Returns the actionable result when
 * it has ≥1 complete missing season, else null. NB: this never inspects
 * `status`, so ENDED / CANCELED shows are NOT skipped (revivals happen) — that is
 * the whole point of including them.
 */
export function evaluateShow(
  show: PlexShow & { tmdbId: number },
  detail: TmdbSeriesDetail,
  seasonEpisodes: Map<number, TmdbEpisode[]>,
  now: Date,
): ShowMissingSeasons | null {
  const seasons = detail.seasons ?? [];
  const missing = completeMissingSeasons(show.highestOwnedSeason, seasons, seasonEpisodes, now);
  if (missing.length === 0) return null;
  return {
    title: show.title,
    year: show.year,
    tmdbId: show.tmdbId,
    ratingKey: show.ratingKey,
    highestOwnedSeason: show.highestOwnedSeason,
    tmdbStatus: detail.status ?? 'Unknown',
    highestAiredSeason: highestAiredSeason(seasons, now),
    completeMissingSeasons: missing,
  };
}
