// Movie-domain wiring over the shared recommender pipeline (src/core/recommender/) —
// unit-tested in recs.test.ts. The load-bearing pure helpers themselves (seeded
// sampling, dedup, balancing, taste-profile slicing) live in
// src/core/recommender/pure.ts (T561); this file re-exports them plus the
// movie-specific bits: the TMDB movie-genre table and the director-completion
// slot of the shared `ownedAtLeast` helper.
import { ownedAtLeast } from '../../core/recommender/pure.js';
import type { TasteProfile } from './types.js';

export {
  balanceByGenre,
  dedupeRawByTitleYear,
  mergeLens,
  mulberry32,
  normTitle,
  primaryGenre,
  recKey,
  seededShuffle,
  stratifiedSample,
  thinGenres,
  topGenres,
} from '../../core/recommender/pure.js';

/** The work_items keyspace for the recommendation dedup/ignore ledger (keyed by
 *  the recommended film's tmdb id). Separate from the franchise-gap ledger. */
export const RECS_JOB = 'movie-recs';

/** Directors the owner owns at least `min` films by (auteur-completion targets). */
export function directorsOwnedAtLeast(profile: TasteProfile, min: number): [string, number][] {
  return ownedAtLeast(profile.directors, min);
}

// ── TMDB movie-genre id → name (the fixed, public TMDB movie-genre list) ──

const TMDB_GENRES: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance',
  878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War',
  37: 'Western',
};

/** Map a TMDB genre_ids[] to a single primary genre NAME (first known id). */
export function genreNameFromIds(ids: number[] | undefined): string {
  for (const id of ids ?? []) if (TMDB_GENRES[id]) return TMDB_GENRES[id];
  return 'Unknown';
}
