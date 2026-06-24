// Pure recommendation-helper tests — the load-bearing rules: STRATIFIED (balanced,
// NOT proportional) sampling, per-genre output balancing, cross-branch dedup, and
// taste-profile slicing. NO live Claude/TMDB; everything synthetic.
import assert from 'node:assert/strict';
import {
  balanceByGenre,
  dedupeRawByTitleYear,
  directorsOwnedAtLeast,
  genreNameFromIds,
  primaryGenre,
  seededShuffle,
  stratifiedSample,
  thinGenres,
  topGenres,
} from './recs.js';
import type { PlexMovie, RawSuggestion, TasteProfile } from './types.js';

function mv(genre: string, i: number): PlexMovie {
  return {
    title: `${genre} ${i}`, year: 2000 + (i % 25), tmdbId: i, ratingKey: String(i),
    genres: [genre], directors: [], countries: [], audienceRating: null, rating: null,
  };
}

// ── stratifiedSample: BALANCED, not proportional (the anti-mode-collapse rule) ──
{
  const lib = [
    ...Array.from({ length: 500 }, (_, i) => mv('Action', i)),
    ...Array.from({ length: 100 }, (_, i) => mv('Horror', 1000 + i)),
  ];
  const sample = stratifiedSample(lib, { keyFn: primaryGenre, target: 40, seed: 7 });
  assert.equal(sample.length, 40, 'samples exactly the target');
  const action = sample.filter((m) => m.genres[0] === 'Action').length;
  const horror = sample.filter((m) => m.genres[0] === 'Horror').length;
  // Proportional would be ~33 Action / ~7 Horror. Stratified must be ~20/20.
  assert.ok(Math.abs(action - horror) <= 1, `balanced split, got ${action}/${horror}`);
  assert.ok(horror >= 18, `horror not drowned out (got ${horror}, proportional would be ~7)`);
  console.log('  ✓ stratifiedSample is balanced, not proportional (500/100 → ~20/20)');
}

// A target larger than a thin stratum drains it then fills from the rest, still
// far more balanced than proportional.
{
  const lib = [
    ...Array.from({ length: 300 }, (_, i) => mv('Action', i)),
    ...Array.from({ length: 20 }, (_, i) => mv('Western', 5000 + i)),
  ];
  const sample = stratifiedSample(lib, { keyFn: primaryGenre, target: 60, seed: 3 });
  const western = sample.filter((m) => m.genres[0] === 'Western').length;
  assert.equal(western, 20, 'the entire thin stratum is taken before over-filling from the dominant one');
  console.log('  ✓ stratifiedSample drains a thin stratum fully before over-sampling the dominant one');
}

// Divergent seeds → divergent slices (so the 3 random branches differ).
{
  const lib = Array.from({ length: 100 }, (_, i) => mv(i % 2 ? 'Action' : 'Drama', i));
  const a = stratifiedSample(lib, { keyFn: primaryGenre, target: 20, seed: 1001 }).map((m) => m.tmdbId);
  const b = stratifiedSample(lib, { keyFn: primaryGenre, target: 20, seed: 1002 }).map((m) => m.tmdbId);
  assert.notDeepEqual(a, b, 'different seeds yield different slices');
  // …but a given seed is deterministic.
  const a2 = stratifiedSample(lib, { keyFn: primaryGenre, target: 20, seed: 1001 }).map((m) => m.tmdbId);
  assert.deepEqual(a, a2, 'same seed is deterministic');
  console.log('  ✓ stratifiedSample diverges by seed yet is deterministic per seed');
}

// ── seededShuffle: deterministic + non-mutating ──
{
  const src = [1, 2, 3, 4, 5];
  const s1 = seededShuffle(src, 42);
  const s2 = seededShuffle(src, 42);
  assert.deepEqual(s1, s2, 'deterministic');
  assert.deepEqual(src, [1, 2, 3, 4, 5], 'input not mutated');
  assert.deepEqual([...s1].sort(), src, 'a permutation of the input');
  console.log('  ✓ seededShuffle is deterministic + non-mutating');
}

// ── balanceByGenre: cap per genre + total target, round-robined ──
{
  const recs = [
    { genre: 'Action', id: 1 }, { genre: 'Action', id: 2 }, { genre: 'Action', id: 3 },
    { genre: 'Drama', id: 4 }, { genre: 'Drama', id: 5 }, { genre: 'Drama', id: 6 },
    { genre: 'Comedy', id: 7 },
  ];
  const out = balanceByGenre(recs, { cap: 2, target: 5 });
  assert.equal(out.length, 5, 'respects the target');
  const counts = out.reduce<Record<string, number>>((a, r) => { a[r.genre] = (a[r.genre] ?? 0) + 1; return a; }, {});
  assert.ok(Object.values(counts).every((c) => c <= 2), 'no genre exceeds the cap');
  assert.equal(counts['Comedy'], 1, 'the lone Comedy is included (round-robin reaches it)');
  console.log('  ✓ balanceByGenre caps per genre and round-robins to the target');
}

// ── dedupeRawByTitleYear: same film once; blanks dropped ──
{
  const raw: RawSuggestion[] = [
    { title: 'Akira', year: 1988, reason: 'a', lens: 'world-cinema' },
    { title: 'akira', year: 1988, reason: 'b', lens: 'serendipity' }, // dup (case/loose)
    { title: 'Akira', year: 2020, reason: 'c', lens: 'x' },           // different year → kept
    { title: '   ', year: null, reason: 'd', lens: 'x' },             // blank → dropped
  ];
  const unique = dedupeRawByTitleYear(raw);
  assert.equal(unique.length, 2);
  assert.equal(unique[0].reason, 'a', 'keeps the first occurrence');
  console.log('  ✓ dedupeRawByTitleYear collapses loose title/year dups, drops blanks');
}

// ── genreNameFromIds: first known TMDB genre id wins ──
assert.equal(genreNameFromIds([27, 53]), 'Horror');
assert.equal(genreNameFromIds([999999, 18]), 'Drama', 'unknown ids skipped');
assert.equal(genreNameFromIds([]), 'Unknown');
assert.equal(genreNameFromIds(undefined), 'Unknown');
console.log('  ✓ genreNameFromIds maps the first known id');

// ── taste-profile slicing: top / thin genres + auteur threshold ──
{
  const profile: TasteProfile = {
    totalMovies: 100, withTmdbId: 100,
    genres: { Action: 50, Horror: 30, Drama: 10, Western: 2, Music: 0 },
    directors: { Nolan: 5, Tarantino: 3, Misc: 1 },
    decades: { '2010s': 60, '1970s': 3 }, countries: { 'United States': 80, France: 5 },
  };
  assert.deepEqual(topGenres(profile, 2).map(([g]) => g), ['Action', 'Horror']);
  assert.deepEqual(thinGenres(profile, 2).map(([g]) => g), ['Western', 'Drama'], 'thinnest owned-but-sparse genres (Music=0 excluded)');
  assert.deepEqual(directorsOwnedAtLeast(profile, 3).map(([d]) => d), ['Nolan', 'Tarantino']);
  console.log('  ✓ topGenres / thinGenres / directorsOwnedAtLeast slice the profile');
}

console.log('  ✓ movies recs pure-helper tests passed');
