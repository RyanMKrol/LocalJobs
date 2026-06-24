// Pure Plex-parsing helpers (no I/O) — unit-tested in plex.test.ts.
import type { PlexEpisodeMeta, PlexGuid, PlexShow, PlexShowMeta } from './types.js';

/**
 * Extract the TMDB id from a show's GUID list. Plex carries one `tmdb://<id>`
 * GUID per show (alongside imdb/tvdb). Matching is ALWAYS by this GUID, never by
 * fuzzy title — that kills silent mismatches. Returns null when no tmdb GUID.
 */
export function extractTmdbId(guids: PlexGuid[] | undefined): number | null {
  if (!Array.isArray(guids)) return null;
  for (const g of guids) {
    const m = /^tmdb:\/\/(\d+)/.exec(g?.id ?? '');
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Map each show's ratingKey → highest owned REGULAR season, derived from the flat
 * episode list: the max `parentIndex` (season number) >0 grouped by
 * `grandparentRatingKey` (the show). Season 0 (specials) is excluded.
 */
export function highestOwnedSeasonMap(episodes: PlexEpisodeMeta[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of episodes) {
    const key = String(e?.grandparentRatingKey ?? '');
    if (!key) continue;
    const s = e?.parentIndex;
    if (typeof s === 'number' && s > 0) m.set(key, Math.max(m.get(key) ?? 0, s));
  }
  return m;
}

/**
 * Build the per-show snapshot from the Plex shows list + the flat episode list.
 * A show with no episodes (or only specials) gets `highestOwnedSeason: 0`.
 */
export function buildShowSnapshots(
  shows: PlexShowMeta[],
  episodes: PlexEpisodeMeta[],
): PlexShow[] {
  const owned = highestOwnedSeasonMap(episodes);
  return shows.map((s) => {
    const ratingKey = String(s?.ratingKey ?? '');
    return {
      title: s?.title ?? '(untitled)',
      year: typeof s?.year === 'number' ? s.year : null,
      tmdbId: extractTmdbId(s?.Guid),
      ratingKey,
      highestOwnedSeason: owned.get(ratingKey) ?? 0,
    };
  });
}
