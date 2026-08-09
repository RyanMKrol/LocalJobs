// Pure-logic tests for the media-reviews helpers — no DB, no filesystem, no AWS.
import assert from 'node:assert/strict';

import {
  buildAlbumReviewMarkdown,
  buildBookReviewMarkdown,
  buildScreenReviewMarkdown,
  contentMarker,
  isoFromDdMmYyyy,
  normalizeAlbum,
  normalizeBook,
  normalizeScreen,
  renderAlbumReview,
  renderBookReview,
  renderMovieReview,
  renderTvReview,
  slugStem,
  stableStringify,
  yearFromIsoDate,
} from './lib.js';

// ── stableStringify / contentMarker ──
assert.equal(
  stableStringify({ b: 1, a: 2 }),
  stableStringify({ a: 2, b: 1 }),
  'object key order does not affect the serialization',
);
assert.equal(
  stableStringify({ outer: { z: 1, a: [{ y: 1, x: 2 }] } }),
  '{"outer":{"a":[{"x":2,"y":1}],"z":1}}',
  'nesting sorts keys recursively; arrays keep order',
);
assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]), 'array order is significant');
assert.equal(
  contentMarker({ title: 'X', rating: 4 }),
  contentMarker({ rating: 4, title: 'X' }),
  'marker is stable under key reordering',
);
assert.notEqual(
  contentMarker({ title: 'X', rating: 4 }),
  contentMarker({ title: 'X', rating: 5 }),
  'any changed field changes the marker',
);
assert.notEqual(
  contentMarker({ title: 'X' }),
  contentMarker({ title: 'X', coverUrl: 'https://x' }),
  'an added (backfilled) field changes the marker even without editedDate',
);
console.log('  ✓ stableStringify/contentMarker: key-order stable, content sensitive');

// ── isoFromDdMmYyyy / yearFromIsoDate ──
assert.equal(isoFromDdMmYyyy('15-03-2024'), '2024-03-15');
assert.equal(isoFromDdMmYyyy('01-12-1999'), '1999-12-01');
assert.equal(isoFromDdMmYyyy('2024-03-15'), '2024-03-15', 'already-ISO passes through');
assert.equal(isoFromDdMmYyyy('garbage'), 'garbage', 'unparseable passes through');
assert.equal(isoFromDdMmYyyy(''), '');
assert.equal(yearFromIsoDate('2016-11-10'), 2016);
assert.equal(yearFromIsoDate('10-11-2016'), null, 'DD-MM-YYYY is NOT a release date');
assert.equal(yearFromIsoDate(undefined), null);
assert.equal(yearFromIsoDate(''), null);
console.log('  ✓ date helpers: DD-MM-YYYY→ISO, year only from ISO tmdbDate');

// ── slugStem ──
assert.equal(slugStem('Norwegian Wood (Haruki Murakami)', 'abcd1234-9999'), 'norwegian-wood-haruki-murakami-abcd1234');
assert.equal(slugStem('***', 'abcd1234-9999'), 'abcd1234', 'stem that slugs to nothing falls back to the id prefix');
assert.ok(slugStem('x'.repeat(300), 'abcd1234').length <= 89, 'length capped');
console.log('  ✓ slugStem: lowercase-dash slug + id suffix');

// ── normalizeBook ──
{
  const book = normalizeBook({
    id: 'b1', title: 'Norwegian Wood', author: 'Haruki Murakami', rating: 4,
    review_text: 'A quiet, sad book.', date: '15-03-2024',
    isbn: '9780375704024', pageCount: 296, subjects: ['Fiction', 42, 'Japan'],
  });
  assert.ok(book, 'valid book normalizes');
  assert.equal(book?.reviewText, 'A quiet, sad book.');
  assert.deepEqual(book?.subjects, ['Fiction', 'Japan'], 'non-string subjects filtered');
  assert.ok(!('publisher' in (book ?? {})), 'absent optionals stay absent');
  assert.equal(normalizeBook({ id: 'b2', title: 'No Author' }), null, 'missing author → null');
  assert.equal(normalizeBook({ title: 'No Id', author: 'X' }), null, 'missing id → null');
}
console.log('  ✓ normalizeBook: required fields enforced, optionals conditional');

// ── normalizeScreen / normalizeAlbum ──
{
  const movie = normalizeScreen({
    id: 'm1', title: 'Arrival', rating: 5, review_text: 'Stunning.',
    date: '01-01-2020', tmdbId: 329865, tmdbDate: '2016-11-10', posterPath: '/poster.jpg',
  });
  assert.ok(movie);
  assert.equal(movie?.tmdbId, 329865);
  assert.equal(normalizeScreen({ id: 'm2' }), null, 'missing title → null');

  const album = normalizeAlbum({
    id: 'a1', title: 'In Rainbows', artist: 'Radiohead', rating: 5,
    highlights: 'Nude; Reckoner.', date: '02-02-2021', thumbnail: '',
    lastfm: { url: 'https://last.fm/x', listeners: '1234567', tags: ['rock'], trackCount: 10 },
  });
  assert.ok(album);
  assert.ok(!('thumbnail' in (album ?? {})), "empty-string thumbnail is treated as absent");
  assert.equal(album?.lastfm?.listeners, '1234567', 'lastfm listeners kept as string');
  assert.equal(normalizeAlbum({ id: 'a2', title: 'No Artist' }), null, 'missing artist → null');
}
console.log('  ✓ normalizeScreen/normalizeAlbum: shapes validated');

// ── buildBookReviewMarkdown ──
{
  const md = buildBookReviewMarkdown({
    id: 'b1', title: 'A "Quoted": Title', author: 'X', rating: 4,
    reviewText: 'Body **markdown** stays verbatim.', date: '15-03-2024',
    editedDate: '16-03-2024', hardcoverSynopsis: 'The synopsis.',
  });
  assert.ok(md.startsWith('---\ntype: book-review\n'), 'frontmatter opens with the fixed type');
  assert.ok(md.includes('title: "A \\"Quoted\\": Title"'), 'string values JSON-escaped');
  assert.ok(md.includes('date: "2024-03-15"'), 'date normalized to ISO');
  assert.ok(md.includes('edited_date: "2024-03-16"'));
  assert.ok(md.includes('\n## Review\n\nBody **markdown** stays verbatim.'), 'review text verbatim');
  assert.ok(md.includes('\n## Synopsis\n\nThe synopsis.'), 'synopsis section when present');
  assert.ok(!md.includes('isbn:'), 'absent optional keys omitted');

  const bare = buildBookReviewMarkdown({ id: 'b2', title: 'T', author: 'A' });
  assert.ok(bare.includes('rating: null'), 'missing rating written as null');
  assert.ok(bare.includes('(no review text recorded)'));
  assert.ok(!bare.includes('## Synopsis'), 'no synopsis section without content');
}
console.log('  ✓ buildBookReviewMarkdown: fixed keys, escaping, optional sections');

// ── buildScreenReviewMarkdown ──
{
  const md = buildScreenReviewMarkdown('movie', {
    id: 'm1', title: 'Arrival', rating: 5, reviewText: 'Stunning.',
    date: '01-01-2020', tmdbId: 329865, tmdbDate: '2016-11-10',
    tmdbOverview: 'Aliens arrive.', posterPath: '/poster.jpg',
  });
  assert.ok(md.includes('type: movie-review'));
  assert.ok(md.includes('year: 2016'), 'year derived from tmdbDate');
  assert.ok(md.includes('release_date: "2016-11-10"'));
  assert.ok(md.includes('poster_url: "https://image.tmdb.org/t/p/w500/poster.jpg"'), 'poster path prefixed');
  assert.ok(md.includes('\n## Overview\n\nAliens arrive.'));

  const tv = buildScreenReviewMarkdown('tv', { id: 't1', title: 'Mr. Robot' });
  assert.ok(tv.includes('type: tv-review'));
  assert.ok(!tv.includes('year:'), 'no year without tmdbDate');
  assert.ok(!tv.includes('poster_url:'), 'no poster without posterPath');
}
console.log('  ✓ buildScreenReviewMarkdown: movie/tv variants, poster URL, year');

// ── buildAlbumReviewMarkdown ──
{
  const md = buildAlbumReviewMarkdown({
    id: 'a1', title: 'In Rainbows', artist: 'Radiohead', rating: 5,
    highlights: 'Nude; Reckoner.', date: '02-02-2021', thumbnail: 'https://img/x.jpg',
    lastfm: {
      url: 'https://last.fm/x', mbid: 'mb-1', releaseDate: '10 October 2007',
      tags: ['rock', 'alternative'], trackCount: 10, listeners: '1234567',
      playcount: '89', summary: 'A landmark album.',
    },
  });
  assert.ok(md.includes('type: album-review'));
  assert.ok(md.includes('artist: "Radiohead"'));
  assert.ok(md.includes('artwork_url: "https://img/x.jpg"'));
  assert.ok(md.includes('release_date: "10 October 2007"'), 'free-text lastfm date quoted');
  assert.ok(md.includes('tags: ["rock", "alternative"]'));
  assert.ok(md.includes('listeners: "1234567"'), 'listeners stays a string');
  assert.ok(md.includes('\n## Highlights\n\nNude; Reckoner.'), 'albums review field is highlights');
  assert.ok(md.includes('\n## About\n\nA landmark album.'));
}
console.log('  ✓ buildAlbumReviewMarkdown: lastfm enrichment, string counts');

// ── render functions (naming) ──
{
  const book = renderBookReview({ id: 'b1', title: 'Norwegian Wood', author: 'Haruki Murakami' });
  assert.equal(book?.name, 'Norwegian Wood (Haruki Murakami)');
  const movie = renderMovieReview({ id: 'm1', title: 'Arrival', tmdbDate: '2016-11-10' });
  assert.equal(movie?.name, 'Arrival (2016)');
  const tvNoYear = renderTvReview({ id: 't1', title: 'Mr. Robot' });
  assert.equal(tvNoYear?.name, 'Mr. Robot', 'no year → bare title');
  const album = renderAlbumReview({ id: 'a1', title: 'In Rainbows', artist: 'Radiohead' });
  assert.equal(album?.name, 'In Rainbows (Radiohead)');
  assert.equal(renderBookReview({ id: 'b9', title: 'No Author' }), null, 'malformed → null');
}
console.log('  ✓ render functions: display names per category');
