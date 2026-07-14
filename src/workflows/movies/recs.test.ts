// Movie-domain recommendation-helper tests. The shared pure-helper rules
// (stratifiedSample, seededShuffle, balanceByGenre, dedupeRawByTitleYear,
// topGenres/thinGenres, mergeLens, ownedAtLeast) are consolidated + tested once
// in src/core/recommender/pure.test.ts (T561) — this file keeps only the
// movie-domain-specific pieces: the TMDB movie-genre table and the
// director-completion wrapper over the shared `ownedAtLeast`.
import assert from 'node:assert/strict';
import { directorsOwnedAtLeast, genreNameFromIds } from './recs.js';
import type { TasteProfile } from './types.js';

// ── genreNameFromIds: first known TMDB genre id wins ──
assert.equal(genreNameFromIds([27, 53]), 'Horror');
assert.equal(genreNameFromIds([999999, 18]), 'Drama', 'unknown ids skipped');
assert.equal(genreNameFromIds([]), 'Unknown');
assert.equal(genreNameFromIds(undefined), 'Unknown');
console.log('  ✓ genreNameFromIds maps the first known id');

// ── directorsOwnedAtLeast: auteur-completion threshold ──
{
  const profile: TasteProfile = {
    totalMovies: 100, withTmdbId: 100,
    genres: { Action: 50, Horror: 30, Drama: 10, Western: 2, Music: 0 },
    directors: { Nolan: 5, Tarantino: 3, Misc: 1 },
    decades: { '2010s': 60, '1970s': 3 }, countries: { 'United States': 80, France: 5 },
  };
  assert.deepEqual(directorsOwnedAtLeast(profile, 3).map(([d]) => d), ['Nolan', 'Tarantino']);
  console.log('  ✓ directorsOwnedAtLeast slices the profile at the auteur-completion threshold');
}

console.log('  ✓ movies recs domain-helper tests passed');
