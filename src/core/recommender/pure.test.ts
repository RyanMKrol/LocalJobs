// Pure recommendation-helper tests (T561) — the load-bearing rules shared by
// every recommender domain: STRATIFIED (balanced, NOT proportional) sampling,
// per-genre output balancing, cross-branch dedup, and taste-profile slicing.
// Consolidated here from the near-identical movies/tv-recs copies; each
// workflow's own recs.test.ts keeps only its domain-specific assertions
// (genreNameFromIds / directorsOwnedAtLeast / creatorsOwnedAtLeast).
import assert from 'node:assert/strict';
import {
  balanceByGenre,
  buildOwnedSet,
  dedupeRawByTitleYear,
  mergeLens,
  normTitle,
  ownedAtLeast,
  primaryGenre,
  recKey,
  seededShuffle,
  stratifiedSample,
  thinGenres,
  topGenres,
} from './pure.js';
import type { RawSuggestion, Recommendation } from './types.js';

interface Item { genre: string; tmdbId: number }
function item(genre: string, i: number): { genres: string[]; tmdbId: number } {
  return { genres: [genre], tmdbId: i };
}

// ── stratifiedSample: BALANCED, not proportional (the anti-mode-collapse rule) ──
{
  const lib = [
    ...Array.from({ length: 500 }, (_, i) => item('Action', i)),
    ...Array.from({ length: 100 }, (_, i) => item('Horror', 1000 + i)),
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

{
  const lib = [
    ...Array.from({ length: 300 }, (_, i) => item('Action', i)),
    ...Array.from({ length: 20 }, (_, i) => item('Western', 5000 + i)),
  ];
  const sample = stratifiedSample(lib, { keyFn: primaryGenre, target: 60, seed: 3 });
  const western = sample.filter((m) => m.genres[0] === 'Western').length;
  assert.equal(western, 20, 'the entire thin stratum is taken before over-filling from the dominant one');
  console.log('  ✓ stratifiedSample drains a thin stratum fully before over-sampling the dominant one');
}

{
  const lib = Array.from({ length: 100 }, (_, i) => item(i % 2 ? 'Action' : 'Drama', i));
  const a = stratifiedSample(lib, { keyFn: primaryGenre, target: 20, seed: 1001 }).map((m) => m.tmdbId);
  const b = stratifiedSample(lib, { keyFn: primaryGenre, target: 20, seed: 1002 }).map((m) => m.tmdbId);
  assert.notDeepEqual(a, b, 'different seeds yield different slices');
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
  assert.deepEqual([...s1].sort((a, b) => a - b), src, 'a permutation of the input');
  console.log('  ✓ seededShuffle is deterministic + non-mutating');
}

// ── balanceByGenre: cap per genre + total target, round-robined ──
{
  const recs: Item[] = [
    { genre: 'Action', tmdbId: 1 }, { genre: 'Action', tmdbId: 2 }, { genre: 'Action', tmdbId: 3 },
    { genre: 'Drama', tmdbId: 4 }, { genre: 'Drama', tmdbId: 5 }, { genre: 'Drama', tmdbId: 6 },
    { genre: 'Comedy', tmdbId: 7 },
  ];
  const out = balanceByGenre(recs, { cap: 2, target: 5 });
  assert.equal(out.length, 5, 'respects the target');
  const counts = out.reduce<Record<string, number>>((a, r) => { a[r.genre] = (a[r.genre] ?? 0) + 1; return a; }, {});
  assert.ok(Object.values(counts).every((c) => c <= 2), 'no genre exceeds the cap');
  assert.equal(counts['Comedy'], 1, 'the lone Comedy is included (round-robin reaches it)');
  console.log('  ✓ balanceByGenre caps per genre and round-robins to the target');
}

// ── dedupeRawByTitleYear: same item once; blanks dropped ──
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

// ── normTitle: lowercases + strips non-alphanumerics ──
assert.equal(normTitle('The Matrix: Reloaded!'), 'the matrix reloaded');
console.log('  ✓ normTitle normalizes case + punctuation');

// ── taste-profile slicing: top / thin genres + generic ownedAtLeast ──
{
  const profile = {
    genres: { Action: 50, Horror: 30, Drama: 10, Western: 2, Music: 0 },
  };
  assert.deepEqual(topGenres(profile, 2).map(([g]) => g), ['Action', 'Horror']);
  assert.deepEqual(thinGenres(profile, 2).map(([g]) => g), ['Western', 'Drama'], 'thinnest owned-but-sparse genres (Music=0 excluded)');
  console.log('  ✓ topGenres / thinGenres slice the profile');
}

{
  const counts = { Nolan: 5, Tarantino: 3, Misc: 1 };
  assert.deepEqual(ownedAtLeast(counts, 3).map(([d]) => d), ['Nolan', 'Tarantino']);
  console.log('  ✓ ownedAtLeast filters and sorts by count (movies\' directorsOwnedAtLeast / tv-recs\' creatorsOwnedAtLeast)');
}

// ── mergeLens: joins a new lens onto an existing recommendation ──
{
  const rec: Recommendation = { tmdbId: 1, title: 'X', year: 2000, reason: 'r', lens: 'serendipity', genre: 'Drama', tmdbRating: 7 };
  mergeLens(rec, 'world-cinema');
  assert.equal(rec.lens, 'serendipity, world-cinema');
  mergeLens(rec, 'serendipity'); // already present → no duplicate
  assert.equal(rec.lens, 'serendipity, world-cinema');
  console.log('  ✓ mergeLens joins a new lens once, no duplicates');
}

// ── recKey / buildOwnedSet ──
assert.equal(recKey(603), '603');
{
  const owned = buildOwnedSet([{ tmdbId: 1 }, { tmdbId: null }, { tmdbId: 2 }]);
  assert.deepEqual([...owned].sort(), [1, 2]);
  console.log('  ✓ recKey stringifies + buildOwnedSet collects non-null tmdbIds');
}

console.log('  ✓ shared recommender pure-helper tests passed');
