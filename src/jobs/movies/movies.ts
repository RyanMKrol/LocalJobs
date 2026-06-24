// Pure Plex/TMDB franchise-gap helpers (no I/O) — unit-tested in movies.test.ts.
import { extractTmdbId } from '../plex/plex.js';
import type {
  FranchiseGap,
  PlexMovie,
  PlexMovieMeta,
  PlexTag,
  TasteProfile,
  TmdbCollectionDetail,
} from './types.js';

// GUID extraction is identical for movies and shows (a `tmdb://<id>` GUID), so we
// reuse the TV workflow's helper rather than duplicating it.
export { extractTmdbId };

/** YYYY-MM-DD for a Date (UTC), so ISO date strings compare lexicographically. */
export function isoDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Flatten a Plex tag array (`[{tag:'Action'}]`) into `['Action']`, dropping blanks. */
function tags(arr: PlexTag[] | undefined): string[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((t) => (t?.tag ?? '').trim()).filter(Boolean);
}

/**
 * Build the per-movie snapshot from the Plex section items. Captures the taste
 * metadata Plex already returns (genres/directors/countries/ratings) so the
 * snapshot doubles as the input to the taste profile (T146).
 */
export function buildMovieSnapshots(movies: PlexMovieMeta[]): PlexMovie[] {
  return movies.map((m) => ({
    title: m?.title ?? '(untitled)',
    year: typeof m?.year === 'number' ? m.year : null,
    tmdbId: extractTmdbId(m?.Guid),
    ratingKey: String(m?.ratingKey ?? ''),
    genres: tags(m?.Genre),
    directors: tags(m?.Director),
    countries: tags(m?.Country),
    audienceRating: typeof m?.audienceRating === 'number' ? m.audienceRating : null,
    rating: typeof m?.rating === 'number' ? m.rating : null,
  }));
}

/** The OWNED set = every tmdbId present in the snapshot (movies with a GUID). */
export function buildOwnedSet(movies: PlexMovie[]): Set<number> {
  const owned = new Set<number>();
  for (const m of movies) if (m.tmdbId != null) owned.add(m.tmdbId);
  return owned;
}

/** Decade label for a year: 1994 → "1990s"; null year → "Unknown". */
export function decadeOf(year: number | null): string {
  if (year == null || !Number.isFinite(year)) return 'Unknown';
  return `${Math.floor(year / 10) * 10}s`;
}

/** Count occurrences of each value into an existing record. */
function tally(into: Record<string, number>, values: string[]): void {
  for (const v of values) into[v] = (into[v] ?? 0) + 1;
}

/**
 * Build the taste profile: per-genre / per-director / per-decade / per-country
 * owned counts. Pure roll-up of the snapshot — T146 consumes it to bias
 * recommendations toward the owner's tastes.
 */
export function buildTasteProfile(movies: PlexMovie[]): TasteProfile {
  const profile: TasteProfile = {
    totalMovies: movies.length,
    withTmdbId: movies.filter((m) => m.tmdbId != null).length,
    genres: {},
    directors: {},
    decades: {},
    countries: {},
  };
  for (const m of movies) {
    tally(profile.genres, m.genres);
    tally(profile.directors, m.directors);
    tally(profile.countries, m.countries);
    profile.decades[decadeOf(m.year)] = (profile.decades[decadeOf(m.year)] ?? 0) + 1;
  }
  return profile;
}

/** Parse the YYYY year out of a TMDB release_date (YYYY-MM-DD); null if absent. */
export function yearOf(releaseDate: string | null | undefined): number | null {
  if (!releaseDate) return null;
  const m = /^(\d{4})/.exec(releaseDate);
  return m ? Number(m[1]) : null;
}

/**
 * A franchise part counts as RELEASED when it has a `release_date` that is on/
 * before `now`. Unreleased / dateless parts (announced sequels) are excluded —
 * they aren't gaps yet. (No quality filter: a released part is in scope
 * regardless of its rating.)
 */
export function isReleasedPart(part: { release_date?: string | null }, now: Date): boolean {
  const d = part.release_date;
  return !!d && d <= isoDay(now);
}

/**
 * The gaps for ONE collection: every RELEASED part whose tmdb id is NOT in the
 * owned set. NO quality filter and NO skip heuristics (owner decision, T109):
 * surface EVERY factual gap; `tmdbRating` rides along for context only.
 */
export function collectionGaps(
  collection: TmdbCollectionDetail,
  owned: Set<number>,
  now: Date,
): FranchiseGap[] {
  const out: FranchiseGap[] = [];
  for (const part of collection.parts ?? []) {
    if (typeof part?.id !== 'number') continue;
    if (!isReleasedPart(part, now)) continue;
    if (owned.has(part.id)) continue;
    out.push({
      collectionId: collection.id,
      collectionName: collection.name ?? `Collection ${collection.id}`,
      tmdbId: part.id,
      title: part.title ?? `(tmdb ${part.id})`,
      year: yearOf(part.release_date),
      tmdbRating: typeof part.vote_average === 'number' ? part.vote_average : null,
    });
  }
  return out;
}
