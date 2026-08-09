// Pure-logic tests for the vault-sync naming helpers — no DB, no filesystem.
import assert from 'node:assert/strict';
import { extractFrontmatterYear, prettyMonth, sanitizeFilename, vaultTargetFor } from './lib.js';

// ── sanitizeFilename ──
assert.equal(sanitizeFilename('The Twilight Saga: Twilight', 'k'), 'The Twilight Saga Twilight');
assert.equal(sanitizeFilename('Good / Bad * Name?', 'k'), 'Good Bad Name');
assert.equal(sanitizeFilename('  .hidden.  ', 'k'), 'hidden');
assert.equal(sanitizeFilename('***', 'movie:123'), 'movie-123', 'empty after cleaning falls back to sanitized key');
assert.equal(sanitizeFilename('', ''), 'untitled');
assert.ok(sanitizeFilename('x'.repeat(300), 'k').length <= 120, 'length capped');
assert.equal(sanitizeFilename('Philosykos — Diptyque', 'k'), 'Philosykos — Diptyque', 'em-dash and spaces survive');
console.log('  ✓ sanitizeFilename strips unsafe characters, caps length, falls back to the key');

// ── prettyMonth ──
assert.equal(prettyMonth('2026-07'), 'July 2026');
assert.equal(prettyMonth('2026-01'), 'January 2026');
assert.equal(prettyMonth('2026-07-3month'), 'July 2026 (Trailing 3 Months)');
assert.equal(prettyMonth('2026-13'), '2026-13', 'impossible month passes through');
assert.equal(prettyMonth('not-a-month'), 'not-a-month');
console.log('  ✓ prettyMonth renders YYYY-MM keys, passing anything else through');

// ── extractFrontmatterYear ──
assert.equal(extractFrontmatterYear('---\ntitle: X\nyear: 2008\n---\n# X'), 2008);
assert.equal(extractFrontmatterYear('---\nyear: "2015"\n---\nbody'), 2015, 'quoted year');
assert.equal(extractFrontmatterYear('---\ntitle: X\n---\nbody'), null, 'no year key');
assert.equal(extractFrontmatterYear('# No frontmatter\nyear: 2008'), null, 'year outside frontmatter ignored');
console.log('  ✓ extractFrontmatterYear reads year only from the leading frontmatter block');

// ── vaultTargetFor ──
const noRead = () => {
  throw new Error('readSourceMd should not be called for this source');
};

assert.deepEqual(vaultTargetFor('enrich-with-llm', 'pid1', 'Akoko', noRead), {
  folder: 'Places',
  baseName: 'Akoko',
});
assert.deepEqual(vaultTargetFor('perfumes-build', 'philosykos__diptyque__edp', 'Philosykos — Diptyque', noRead), {
  folder: 'Perfumes',
  baseName: 'Philosykos — Diptyque (EDP)',
});
assert.deepEqual(vaultTargetFor('perfumes-build', 'two__segments', 'Two Segments', noRead), {
  folder: 'Perfumes',
  baseName: 'Two Segments',
}, 'a key with no concentration segment gets no suffix');
assert.deepEqual(vaultTargetFor('plex-profiles-build', 'movie:10157', 'Twilight', () => '---\nyear: 2008\n---\n'), {
  folder: 'Plex/Movies',
  baseName: 'Twilight (2008)',
});
assert.deepEqual(vaultTargetFor('plex-profiles-build', 'show:10055', 'Mr. Robot', () => '---\nyear: 2015\n---\n'), {
  folder: 'Plex/TV',
  baseName: 'Mr. Robot (2015)',
});
assert.deepEqual(vaultTargetFor('plex-profiles-build', 'movie:1', 'No Year', () => '# no frontmatter'), {
  folder: 'Plex/Movies',
  baseName: 'No Year',
}, 'missing year omits the parenthetical');
assert.deepEqual(vaultTargetFor('lastfm-digest', '2026-07-3month', 'Listening digest (trailing 3 months) — July 2026', noRead), {
  folder: 'Listening',
  baseName: 'July 2026 (Trailing 3 Months)',
});
assert.deepEqual(vaultTargetFor('workouts-progress', '2026-07', 'Workouts progress — 2026-07', noRead), {
  folder: 'Workouts',
  baseName: 'July 2026',
});
assert.deepEqual(vaultTargetFor('media-reviews-books', 'book-0001-aaaa', 'Norwegian Wood (Haruki Murakami)', noRead), {
  folder: 'Reviews/Books',
  baseName: 'Norwegian Wood (Haruki Murakami)',
});
assert.deepEqual(vaultTargetFor('media-reviews-movies', 'movie-0001-bbbb', 'Arrival (2016)', noRead), {
  folder: 'Reviews/Movies',
  baseName: 'Arrival (2016)',
});
assert.deepEqual(vaultTargetFor('media-reviews-tv', 'tv-0001-cccc', 'Mr. Robot (2015)', noRead), {
  folder: 'Reviews/TV',
  baseName: 'Mr. Robot (2015)',
});
assert.deepEqual(vaultTargetFor('media-reviews-albums', 'album-0001-dddd', 'In Rainbows (Radiohead)', noRead), {
  folder: 'Reviews/Albums',
  baseName: 'In Rainbows (Radiohead)',
});
assert.deepEqual(vaultTargetFor('media-reviews-books', 'book-0002-eeee', null, noRead), {
  folder: 'Reviews/Books',
  baseName: 'book-0002-eeee',
}, 'a review row with no detail.name falls back to the item key');
console.log('  ✓ vaultTargetFor maps each source to its folder + prettified name');
