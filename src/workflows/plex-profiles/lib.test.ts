import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildMovieProfileMarkdown,
  buildShowProfileMarkdown,
  extractGuidIds,
  formatBytes,
  itemBytes,
  slugFileName,
  tags,
} from './lib.js';
import type { PlexMovieDetail, PlexShowDetail } from './types.js';

// ---------------------------------------------------------------------------
// extractGuidIds
// ---------------------------------------------------------------------------

test('extractGuidIds pulls tmdb/imdb/tvdb ids from a Guid array', () => {
  const ids = extractGuidIds([
    { id: 'imdb://tt28658276' },
    { id: 'tmdb://1146556' },
    { id: 'tvdb://358850' },
  ]);
  assert.deepEqual(ids, { tmdbId: 1146556, imdbId: 'tt28658276', tvdbId: '358850' });
});

test('extractGuidIds returns nulls when absent/malformed', () => {
  assert.deepEqual(extractGuidIds(undefined), { tmdbId: null, imdbId: null, tvdbId: null });
  assert.deepEqual(extractGuidIds([{ id: 'plex://movie/abc' }]), { tmdbId: null, imdbId: null, tvdbId: null });
});

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

test('tags flattens a Plex tag array and drops blanks', () => {
  assert.deepEqual(tags([{ tag: 'Action' }, { tag: '' }, { tag: 'Sci-Fi' }]), ['Action', 'Sci-Fi']);
  assert.deepEqual(tags(undefined), []);
});

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------

test('formatBytes formats sizes in binary units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024 * 1024 * 5), '5.0 MB');
  assert.equal(formatBytes(1024 ** 3 * 2.5), '2.5 GB');
});

// ---------------------------------------------------------------------------
// itemBytes
// ---------------------------------------------------------------------------

test('itemBytes sums every Media.Part.size', () => {
  const item = { Media: [{ Part: [{ size: 100 }, { size: 200 }] }, { Part: [{ size: 50 }] }] };
  assert.equal(itemBytes(item), 350);
});

test('itemBytes returns 0 when no Media', () => {
  assert.equal(itemBytes({}), 0);
});

// ---------------------------------------------------------------------------
// slugFileName
// ---------------------------------------------------------------------------

test('slugFileName combines ratingKey + slug', () => {
  assert.equal(slugFileName(37974, 'the-430-movie-2024'), '37974-the-430-movie-2024');
});

test('slugFileName falls back to bare ratingKey when slug is absent', () => {
  assert.equal(slugFileName('123', undefined), '123');
  assert.equal(slugFileName(undefined, undefined), '0');
});

// ---------------------------------------------------------------------------
// buildMovieProfileMarkdown
// ---------------------------------------------------------------------------

function makeMovieDetail(overrides: Partial<PlexMovieDetail> = {}): PlexMovieDetail {
  return {
    ratingKey: 37974,
    slug: 'the-430-movie-2024',
    title: 'The 4:30 Movie',
    year: 2024,
    studio: 'A24',
    contentRating: 'PG-13',
    summary: 'A summer at the movies.',
    tagline: 'Every summer has a story.',
    rating: 6.5,
    audienceRating: 7.2,
    duration: 7_080_000,
    addedAt: 1_700_000_000,
    updatedAt: 1_700_100_000,
    Genre: [{ tag: 'Comedy' }],
    Country: [{ tag: 'USA' }],
    Director: [{ tag: 'Kevin Smith' }],
    Writer: [{ tag: 'Kevin Smith' }],
    Role: [{ tag: 'Austin Zajur' }, { tag: 'Siena Agudong' }],
    Guid: [{ id: 'tmdb://1146556' }, { id: 'imdb://tt28658276' }],
    Rating: [{ image: 'rottentomatoes://', value: 6.1, type: 'critic' }],
    Media: [{ videoResolution: '1080', videoCodec: 'h264', container: 'mkv', Part: [{ size: 4_000_000_000, file: '/movies/the-430-movie.mkv' }] }],
    ...overrides,
  };
}

test('buildMovieProfileMarkdown includes fixed frontmatter keys and required headings', () => {
  const md = buildMovieProfileMarkdown(makeMovieDetail());
  assert.ok(md.startsWith('---\ntype: movie'));
  assert.match(md, /rating_key: "37974"/);
  assert.match(md, /title: "The 4:30 Movie"/);
  assert.match(md, /tmdb_id: 1146556/);
  assert.match(md, /imdb_id: "tt28658276"/);
  for (const heading of ['## Summary', '## Cast & Crew', '## Ratings', '## Technical', '## Source']) {
    assert.ok(md.includes(heading), `missing heading ${heading}`);
  }
  assert.ok(md.includes('Kevin Smith'));
  assert.ok(md.includes('4.0 GB') || md.includes('3.7 GB'));
  assert.ok(md.includes('/movies/the-430-movie.mkv'));
});

test('buildMovieProfileMarkdown handles missing optional fields gracefully', () => {
  const md = buildMovieProfileMarkdown({ ratingKey: 1, title: 'Bare' });
  assert.ok(md.includes('## Summary'));
  assert.ok(md.includes('(no summary available)'));
  assert.ok(md.includes('unknown'));
});

// ---------------------------------------------------------------------------
// buildShowProfileMarkdown
// ---------------------------------------------------------------------------

function makeShowDetail(overrides: Partial<PlexShowDetail> = {}): PlexShowDetail {
  return {
    ratingKey: 500,
    slug: 'some-show',
    title: 'Some Show',
    originalTitle: 'Some Show',
    year: 2020,
    studio: 'HBO',
    contentRating: 'TV-MA',
    summary: 'A great show.',
    audienceRating: 8.5,
    leafCount: 40,
    childCount: 4,
    Genre: [{ tag: 'Drama' }],
    Country: [{ tag: 'UK' }],
    Role: [{ tag: 'Actor One' }],
    Guid: [{ id: 'tvdb://358850' }],
    Rating: [{ image: 'imdb://', value: 8.7, type: 'audience' }],
    ...overrides,
  };
}

test('buildShowProfileMarkdown includes fixed frontmatter keys and required headings', () => {
  const md = buildShowProfileMarkdown(makeShowDetail(), 12_000_000_000);
  assert.ok(md.startsWith('---\ntype: show'));
  assert.match(md, /rating_key: "500"/);
  assert.match(md, /tvdb_id: "358850"/);
  for (const heading of ['## Summary', '## Cast & Crew', '## Ratings', '## Technical', '## Source']) {
    assert.ok(md.includes(heading), `missing heading ${heading}`);
  }
  assert.ok(md.includes('Seasons: 4'));
  assert.ok(md.includes('Episodes: 40'));
  assert.ok(md.includes('11.2 GB'));
});

test('buildShowProfileMarkdown omits original_title when identical to title', () => {
  const md = buildShowProfileMarkdown(makeShowDetail({ originalTitle: 'Some Show' }), 0);
  assert.ok(!md.includes('original_title:'));
});

test('buildShowProfileMarkdown includes original_title when it differs', () => {
  const md = buildShowProfileMarkdown(makeShowDetail({ title: 'Some Show', originalTitle: 'Un Show' }), 0);
  assert.ok(md.includes('original_title: "Un Show"'));
});
