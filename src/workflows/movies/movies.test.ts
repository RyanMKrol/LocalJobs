// Pure franchise-gap helper tests — GUID extraction, owned-set, taste profile,
// release filtering, and collection-gap detection. NO live Plex/TMDB; everything
// is synthetic. Covers the load-bearing detection rules: released-not-owned,
// exclude unreleased parts, and the "own 9/10 Saw → Saw X missing" model.
import assert from 'node:assert/strict';
import {
  buildMovieSnapshots,
  buildOwnedSet,
  buildTasteProfile,
  collectionGaps,
  collectionOwnedExample,
  decadeOf,
  extractTmdbId,
  isReleasedPart,
  yearOf,
} from './movies.js';
import type { PlexMovieMeta, TmdbCollectionDetail } from './types.js';

const NOW = new Date('2026-06-24T00:00:00Z');

// ── extractTmdbId (reused from the TV workflow) ──
assert.equal(extractTmdbId([{ id: 'imdb://tt1' }, { id: 'tmdb://603' }]), 603);
assert.equal(extractTmdbId([{ id: 'imdb://tt1' }]), null, 'no tmdb GUID → null');
assert.equal(extractTmdbId(undefined), null);
console.log('  ✓ extractTmdbId pulls the tmdb:// id (or null)');

// ── buildMovieSnapshots: title/year/tmdbId + taste metadata ──
const meta: PlexMovieMeta[] = [
  {
    title: 'The Matrix', year: 1999, ratingKey: '10', audienceRating: 8.7, rating: 8.2,
    Guid: [{ id: 'tmdb://603' }],
    Genre: [{ tag: 'Action' }, { tag: 'Sci-Fi' }],
    Director: [{ tag: 'Lana Wachowski' }],
    Country: [{ tag: 'United States' }],
  },
  { title: 'Untracked', Guid: [{ id: 'imdb://tt99' }] }, // no tmdb GUID
];
const movies = buildMovieSnapshots(meta);
assert.equal(movies.length, 2);
assert.equal(movies[0].tmdbId, 603);
assert.deepEqual(movies[0].genres, ['Action', 'Sci-Fi']);
assert.deepEqual(movies[0].directors, ['Lana Wachowski']);
assert.equal(movies[0].audienceRating, 8.7);
assert.equal(movies[1].tmdbId, null, 'a movie with no tmdb:// GUID → tmdbId null');
assert.equal(movies[1].year, null, 'missing year → null');
console.log('  ✓ buildMovieSnapshots captures tmdbId + taste metadata');

// ── buildOwnedSet: only GUID-matched movies ──
const owned = buildOwnedSet(movies);
assert.ok(owned.has(603));
assert.equal(owned.size, 1, 'the untracked movie is not in the owned set');
console.log('  ✓ buildOwnedSet = the GUID-matched tmdbIds');

// ── decadeOf / yearOf ──
assert.equal(decadeOf(1994), '1990s');
assert.equal(decadeOf(2004), '2000s');
assert.equal(decadeOf(null), 'Unknown');
assert.equal(yearOf('2023-10-26'), 2023);
assert.equal(yearOf(null), null);
console.log('  ✓ decadeOf / yearOf');

// ── buildTasteProfile: per-genre / per-decade counts ──
const profile = buildTasteProfile(movies);
assert.equal(profile.totalMovies, 2);
assert.equal(profile.withTmdbId, 1);
assert.equal(profile.genres['Action'], 1);
assert.equal(profile.genres['Sci-Fi'], 1);
assert.equal(profile.decades['1990s'], 1);
assert.equal(profile.decades['Unknown'], 1, 'the year-less movie tallies under Unknown');
assert.equal(profile.directors['Lana Wachowski'], 1);
console.log('  ✓ buildTasteProfile rolls up genres/directors/decades/countries');

// ── isReleasedPart: dated ≤ today is released; future/dateless is not ──
assert.equal(isReleasedPart({ release_date: '2024-01-01' }, NOW), true);
assert.equal(isReleasedPart({ release_date: '2026-06-24' }, NOW), true, 'today counts as released');
assert.equal(isReleasedPart({ release_date: '2027-12-01' }, NOW), false, 'future is not released');
assert.equal(isReleasedPart({ release_date: null }, NOW), false, 'dateless (announced) is not released');
assert.equal(isReleasedPart({}, NOW), false);
console.log('  ✓ isReleasedPart includes today, excludes future/dateless');

// ── collectionGaps: "own 9/10 Saw → Saw X missing" + exclude unreleased ──
const saw: TmdbCollectionDetail = {
  id: 656,
  name: 'Saw Collection',
  parts: [
    { id: 1, title: 'Saw', release_date: '2004-10-29', vote_average: 7.4 },
    { id: 2, title: 'Saw II', release_date: '2005-10-28', vote_average: 6.4 },
    { id: 3, title: 'Saw III', release_date: '2006-10-27', vote_average: 6.2 },
    { id: 4, title: 'Saw IV', release_date: '2007-10-26', vote_average: 5.8 },
    { id: 5, title: 'Saw V', release_date: '2008-10-24', vote_average: 5.7 },
    { id: 6, title: 'Saw VI', release_date: '2009-10-23', vote_average: 6.1 },
    { id: 7, title: 'Saw 3D', release_date: '2010-10-29', vote_average: 5.6 },
    { id: 8, title: 'Jigsaw', release_date: '2017-10-27', vote_average: 6.0 },
    { id: 9, title: 'Spiral', release_date: '2021-05-12', vote_average: 5.5 },
    { id: 10, title: 'Saw X', release_date: '2023-09-26', vote_average: 7.3 },
    { id: 11, title: 'Saw XI', release_date: '2027-09-24', vote_average: 0 }, // unreleased sequel
  ],
};
// Owner owns parts 1–9 but NOT Saw X (10); part 11 is announced/unreleased.
const ownSaw = new Set<number>([1, 2, 3, 4, 5, 6, 7, 8, 9]);
const sawGaps = collectionGaps(saw, ownSaw, NOW);
assert.equal(sawGaps.length, 1, 'exactly one gap — Saw X (the unreleased XI is excluded)');
assert.equal(sawGaps[0].title, 'Saw X');
assert.equal(sawGaps[0].tmdbId, 10);
assert.equal(sawGaps[0].year, 2023);
assert.equal(sawGaps[0].tmdbRating, 7.3, 'TMDB rating rides along as context');
assert.equal(sawGaps[0].collectionName, 'Saw Collection');
console.log('  ✓ collectionGaps surfaces released-not-owned (Saw X), excludes unreleased (Saw XI)');

// ── NO quality filter: a low-rated released gap is STILL surfaced ──
const lowRated: TmdbCollectionDetail = {
  id: 9,
  name: 'Trash Collection',
  parts: [
    { id: 100, title: 'Good One', release_date: '2010-01-01', vote_average: 8.0 },
    { id: 101, title: 'Awful Sequel', release_date: '2012-01-01', vote_average: 2.1 },
  ],
};
const trashGaps = collectionGaps(lowRated, new Set([100]), NOW);
assert.equal(trashGaps.length, 1);
assert.equal(trashGaps[0].title, 'Awful Sequel', 'a 2.1-rated film is still a gap (no quality filter)');
console.log('  ✓ collectionGaps applies NO quality filter');

// ── own ALL released parts → no gaps ──
assert.equal(collectionGaps(saw, new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), NOW).length, 0,
  'owning every released part → no gaps');
console.log('  ✓ collectionGaps is empty when the franchise is complete');

// ── collectionOwnedExample: earliest owned part as the recognisable anchor ──
// Own parts 1 (2004), 3 (2006) — the earliest owned is Saw (2004).
const exampleEarliest = collectionOwnedExample(saw, new Set([1, 3]));
assert.ok(exampleEarliest, 'owned example is returned when owner has parts');
assert.equal(exampleEarliest!.title, 'Saw', 'picks the earliest owned film');
assert.equal(exampleEarliest!.year, 2004);
// Own nothing → null.
assert.equal(collectionOwnedExample(saw, new Set()), null, 'no owned parts → null');
// Dateless part: a part with no release_date has year null, which sorts last.
const withDateless: TmdbCollectionDetail = {
  id: 99, name: 'X', parts: [
    { id: 10, title: 'Middle', release_date: '2010-01-01' },
    { id: 11, title: 'Dateless' }, // no release_date → year null
  ],
};
const exDateless = collectionOwnedExample(withDateless, new Set([10, 11]));
assert.equal(exDateless!.title, 'Middle', 'dateless parts sort last (year null → 9999)');
console.log('  ✓ collectionOwnedExample picks the earliest owned film (null when none)');

console.log('  ✓ movies pure-helper tests passed');
