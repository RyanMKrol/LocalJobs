// Pure-logic tests for the Plex space-saver size breakdown — NO live Plex. Synthetic
// fixtures exercise: per-part byte summation, human-readable formatting, one-row-per-movie,
// one-row-per-show (summed across every episode/season), and biggest-first sorting.
import assert from 'node:assert/strict';
import { buildBreakdown, buildMovieRows, buildShowRows, formatBytes, itemBytes } from './lib.js';
import { weekKey } from './stages/scan.js';
import type { PlexEpisodeMeta, PlexMovieMeta, PlexShowMeta } from './types.js';

// ── itemBytes sums every Media[].Part[].size ──
assert.equal(itemBytes({ Media: [{ Part: [{ size: 100 }, { size: 50 }] }, { Part: [{ size: 25 }] }] }), 175);
assert.equal(itemBytes({}), 0, 'no Media → 0 bytes');
assert.equal(itemBytes({ Media: [{ Part: [{}] }] }), 0, 'a part with no size contributes 0');
console.log('  ✓ itemBytes sums all parts across all media');

// ── formatBytes ──
assert.equal(formatBytes(0), '0 B');
assert.equal(formatBytes(500), '500 B');
assert.equal(formatBytes(1536), '1.5 KB');
assert.equal(formatBytes(1024 ** 3 * 12.3), '12.3 GB');
console.log('  ✓ formatBytes renders human-readable sizes');

// ── buildMovieRows: one row per movie ──
const movies: PlexMovieMeta[] = [
  { title: 'Big Movie', year: 2020, ratingKey: 'm1', Media: [{ Part: [{ size: 1024 ** 3 * 10 }] }] },
  { title: 'Small Movie', year: 2021, ratingKey: 'm2', Media: [{ Part: [{ size: 1024 ** 3 * 2 }] }] },
];
const movieRows = buildMovieRows(movies);
assert.equal(movieRows.length, 2);
assert.equal(movieRows.find((r) => r.ratingKey === 'm1')!.type, 'movie');
assert.equal(movieRows.find((r) => r.ratingKey === 'm1')!.bytes, 1024 ** 3 * 10);
console.log('  ✓ buildMovieRows: one row per movie');

// ── buildShowRows: one row per show, summing episodes across ALL seasons ──
const shows: PlexShowMeta[] = [
  { title: 'Big Show', year: 2010, ratingKey: 's1' },
  { title: 'No Episodes Show', year: 2015, ratingKey: 's2' },
];
const episodes: PlexEpisodeMeta[] = [
  { grandparentRatingKey: 's1', Media: [{ Part: [{ size: 1024 ** 3 * 1 }] }] }, // S1E1
  { grandparentRatingKey: 's1', Media: [{ Part: [{ size: 1024 ** 3 * 1 }] }] }, // S1E2
  { grandparentRatingKey: 's1', Media: [{ Part: [{ size: 1024 ** 3 * 2 }] }] }, // S2E1 — different season, still summed
];
const showRows = buildShowRows(shows, episodes);
const s1 = showRows.find((r) => r.ratingKey === 's1')!;
assert.equal(s1.type, 'show');
assert.equal(s1.bytes, 1024 ** 3 * 4, 'sums episodes across every season');
const s2 = showRows.find((r) => r.ratingKey === 's2')!;
assert.equal(s2.bytes, 0, 'a show with no episodes gets 0 bytes, not dropped');
console.log('  ✓ buildShowRows: one row per show, summed across all seasons');

// ── buildBreakdown: combines + sorts biggest-first ──
const now = new Date('2026-07-03T00:00:00Z');
const breakdown = buildBreakdown(movieRows, showRows, '4', '5', now);
assert.equal(breakdown.movieCount, 2);
assert.equal(breakdown.showCount, 2);
assert.equal(breakdown.items.length, 4);
assert.equal(breakdown.items[0].ratingKey, 'm1', 'biggest item (10 GB movie) sorts first');
assert.ok(breakdown.items.every((item, i) => i === 0 || item.bytes <= breakdown.items[i - 1].bytes), 'strictly biggest-first');
assert.equal(breakdown.totalBytes, 1024 ** 3 * (10 + 2 + 4 + 0));
console.log('  ✓ buildBreakdown combines movie+show rows, sorted biggest-first');

// ── weekKey — ISO week, matches stock-digest's convention ──
assert.equal(weekKey(new Date('2026-07-03T00:00:00Z')), '2026-W27');
console.log('  ✓ weekKey computes the ISO-8601 week key');

console.log('  ✓ plex-space-saver pure-logic tests passed');
