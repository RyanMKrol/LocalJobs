// TV-domain wiring over the shared recommender pipeline (src/core/recommender/) —
// unit-tested in recs.test.ts. The load-bearing pure helpers themselves (seeded
// sampling, dedup, balancing, taste-profile slicing) live in
// src/core/recommender/pure.ts (T561); this file re-exports them plus the
// TV-specific bit: the creator/showrunner-completion slot of the shared
// `ownedAtLeast` helper.
import { ownedAtLeast } from '../../core/recommender/pure.js';
import type { TvTasteProfile } from './types.js';

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

/** The work_items keyspace for the TV recommendation dedup/ignore ledger. */
export const RECS_JOB = 'tv-recs';

/** Creators/showrunners the owner owns at least `min` shows by (completion targets). */
export function creatorsOwnedAtLeast(profile: TvTasteProfile, min: number): [string, number][] {
  return ownedAtLeast(profile.roles, min);
}
