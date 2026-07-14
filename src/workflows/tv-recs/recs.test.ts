// TV-domain recommendation-helper tests. The shared pure-helper rules
// (stratifiedSample, seededShuffle, balanceByGenre, dedupeRawByTitleYear,
// topGenres/thinGenres, mergeLens, ownedAtLeast) are consolidated + tested once
// in src/core/recommender/pure.test.ts (T561) — this file keeps only the
// TV-domain-specific piece: the creator/showrunner-completion wrapper over the
// shared `ownedAtLeast`.
import assert from 'node:assert/strict';
import { creatorsOwnedAtLeast } from './recs.js';
import type { TvTasteProfile } from './types.js';

function profile(genres: Record<string, number>, roles: Record<string, number> = {}): TvTasteProfile {
  return { totalShows: 100, withTmdbId: 90, genres, roles, decades: {}, countries: {} };
}

// ── creatorsOwnedAtLeast ──
{
  const p = profile({}, { 'David Simon': 5, 'Vince Gilligan': 3, 'Chuck Lorre': 1 });
  const creators = creatorsOwnedAtLeast(p, 3);
  assert.equal(creators.length, 2);
  assert.equal(creators[0][0], 'David Simon');
  assert.equal(creators[1][0], 'Vince Gilligan');
  console.log('  ✓ creatorsOwnedAtLeast filters and sorts correctly');
}

console.log('All TV recs domain-helper tests passed.');
