// Pure TV-show snapshot + taste-profile helpers (no I/O) — unit-tested in tv-snapshot.test.ts.
import { extractTmdbId } from '../plex/plex.js';
import type { PlexShow, PlexShowMeta, PlexTag, TvTasteProfile } from './types.js';

export { extractTmdbId };

/** Decade label for a year: 1994 → "1990s"; null year → "Unknown". */
export function decadeOf(year: number | null): string {
  if (year == null || !Number.isFinite(year)) return 'Unknown';
  return `${Math.floor(year / 10) * 10}s`;
}

/** Flatten a Plex tag array (`[{tag:'Drama'}]`) into `['Drama']`, dropping blanks. */
function tags(arr: PlexTag[] | undefined): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((t) => (t?.tag ?? '').trim()).filter(Boolean);
}

/** Count occurrences of each value into an existing record. */
function tally(into: Record<string, number>, values: string[]): void {
  for (const v of values) into[v] = (into[v] ?? 0) + 1;
}

/**
 * Build the per-show snapshot from the Plex section items. Captures taste
 * metadata Plex already returns (genres/roles/countries/ratings/seasons) so the
 * snapshot doubles as the input to the taste profile.
 */
export function buildShowSnapshots(shows: PlexShowMeta[]): PlexShow[] {
  return shows.map((s) => ({
    title: s?.title ?? '(untitled)',
    year: typeof s?.year === 'number' ? s.year : null,
    tmdbId: extractTmdbId(s?.Guid),
    ratingKey: String(s?.ratingKey ?? ''),
    genres: tags(s?.Genre),
    roles: tags(s?.Role),
    countries: tags(s?.Country),
    studio: typeof s?.studio === 'string' && s.studio.trim() ? s.studio.trim() : null,
    audienceRating: typeof s?.audienceRating === 'number' ? s.audienceRating : null,
    rating: typeof s?.rating === 'number' ? s.rating : null,
    seasonCount: typeof s?.childCount === 'number' ? s.childCount : null,
  }));
}

/** The OWNED set = every tmdbId present in the snapshot (shows with a GUID). */
export function buildOwnedSet(shows: PlexShow[]): Set<number> {
  const owned = new Set<number>();
  for (const s of shows) if (s.tmdbId != null) owned.add(s.tmdbId);
  return owned;
}

/**
 * Build the TV taste profile: per-genre / per-role / per-decade / per-country
 * owned counts. Pure roll-up of the snapshot.
 */
export function buildTvTasteProfile(shows: PlexShow[]): TvTasteProfile {
  const profile: TvTasteProfile = {
    totalShows: shows.length,
    withTmdbId: shows.filter((s) => s.tmdbId != null).length,
    genres: {},
    roles: {},
    decades: {},
    countries: {},
  };
  for (const s of shows) {
    tally(profile.genres, s.genres);
    tally(profile.roles, s.roles);
    tally(profile.countries, s.countries);
    profile.decades[decadeOf(s.year)] = (profile.decades[decadeOf(s.year)] ?? 0) + 1;
  }
  return profile;
}
