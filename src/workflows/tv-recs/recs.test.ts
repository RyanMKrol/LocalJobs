// Pure TV recommendation-helper tests — stratified sampling, per-genre balancing,
// cross-branch dedup. NO live Claude/TMDB; everything synthetic.
import assert from 'node:assert/strict';
import {
  balanceByGenre,
  dedupeRawByTitleYear,
  creatorsOwnedAtLeast,
  primaryGenre,
  seededShuffle,
  stratifiedSample,
  thinGenres,
  topGenres,
} from './recs.js';
import type { PlexShow, RawSuggestion, TvTasteProfile } from './types.js';

function show(genre: string, i: number): PlexShow {
  return {
    title: `${genre} ${i}`, year: 2000 + (i % 25), tmdbId: i, ratingKey: String(i),
    genres: [genre], roles: [], countries: [], studio: null,
    audienceRating: null, rating: null, seasonCount: null,
  };
}

function profile(genres: Record<string, number>, roles: Record<string, number> = {}): TvTasteProfile {
  return { totalShows: 100, withTmdbId: 90, genres, roles, decades: {}, countries: {} };
}

// ── stratifiedSample: BALANCED, not proportional ──
{
  const lib = [
    ...Array.from({ length: 500 }, (_, i) => show('Drama', i)),
    ...Array.from({ length: 100 }, (_, i) => show('Comedy', 1000 + i)),
  ];
  const sample = stratifiedSample(lib, { keyFn: primaryGenre, target: 40, seed: 7 });
  assert.equal(sample.length, 40, 'samples exactly the target');
  const drama = sample.filter((s) => s.genres[0] === 'Drama').length;
  const comedy = sample.filter((s) => s.genres[0] === 'Comedy').length;
  assert.ok(Math.abs(drama - comedy) <= 1, `balanced split, got ${drama}/${comedy}`);
  assert.ok(comedy >= 18, `comedy not drowned out (got ${comedy}, proportional would be ~7)`);
  console.log('  ✓ stratifiedSample is balanced, not proportional (500/100 → ~20/20)');
}

{
  const lib = [
    ...Array.from({ length: 300 }, (_, i) => show('Crime', i)),
    ...Array.from({ length: 20 }, (_, i) => show('Western', 5000 + i)),
  ];
  const sample = stratifiedSample(lib, { keyFn: primaryGenre, target: 60, seed: 3 });
  const western = sample.filter((s) => s.genres[0] === 'Western').length;
  assert.equal(western, 20, 'the entire thin stratum is taken before over-filling from the dominant one');
  console.log('  ✓ stratifiedSample drains a thin stratum fully before over-sampling the dominant one');
}

{
  const lib = Array.from({ length: 100 }, (_, i) => show(i % 2 ? 'Drama' : 'Comedy', i));
  const a = stratifiedSample(lib, { keyFn: primaryGenre, target: 20, seed: 1001 }).map((s) => s.tmdbId);
  const b = stratifiedSample(lib, { keyFn: primaryGenre, target: 20, seed: 1002 }).map((s) => s.tmdbId);
  assert.notDeepEqual(a, b, 'different seeds yield different slices');
  const a2 = stratifiedSample(lib, { keyFn: primaryGenre, target: 20, seed: 1001 }).map((s) => s.tmdbId);
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
  const recs = [
    { genre: 'Drama', id: 1 }, { genre: 'Drama', id: 2 }, { genre: 'Drama', id: 3 },
    { genre: 'Comedy', id: 4 }, { genre: 'Comedy', id: 5 }, { genre: 'Comedy', id: 6 },
    { genre: 'Crime', id: 7 },
  ];
  const out = balanceByGenre(recs, { cap: 2, target: 5 });
  assert.equal(out.length, 5, 'respects the target');
  const counts = out.reduce<Record<string, number>>((a, r) => { a[r.genre] = (a[r.genre] ?? 0) + 1; return a; }, {});
  assert.ok(Object.values(counts).every((c) => c <= 2), 'no genre exceeds the cap');
  assert.equal(counts['Crime'], 1, 'the lone Crime show is included (round-robin reaches it)');
  console.log('  ✓ balanceByGenre caps per genre and round-robins to the target');
}

// ── dedupeRawByTitleYear: same show once; blanks dropped ──
{
  const raw: RawSuggestion[] = [
    { title: 'The Wire', year: 2002, reason: 'a', lens: 'world-tv' },
    { title: 'the wire', year: 2002, reason: 'b', lens: 'serendipity' }, // dup
    { title: 'The Wire', year: 2010, reason: 'c', lens: 'x' },           // different year → kept
    { title: '   ', year: null, reason: 'd', lens: 'x' },                 // blank → dropped
  ];
  const unique = dedupeRawByTitleYear(raw);
  assert.equal(unique.length, 2, 'collapsed to 2 unique (title+year)');
  assert.equal(unique[0].title, 'The Wire', 'first occurrence kept');
  assert.equal(unique[0].year, 2002);
  assert.equal(unique[1].year, 2010);
  console.log('  ✓ dedupeRawByTitleYear collapses title+year dupes and drops blanks');
}

// ── topGenres / thinGenres ──
{
  const p = profile({ Drama: 50, Comedy: 30, Horror: 5, Crime: 8 });
  const top = topGenres(p, 2);
  assert.deepEqual(top[0][0], 'Drama');
  assert.deepEqual(top[1][0], 'Comedy');
  const thin = thinGenres(p, 2);
  assert.deepEqual(thin[0][0], 'Horror');
  assert.deepEqual(thin[1][0], 'Crime');
  console.log('  ✓ topGenres and thinGenres slice correctly');
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

console.log('All TV recs helper tests passed.');
