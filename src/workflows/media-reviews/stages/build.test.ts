// runReviewBuild engine tests — injected scan (no AWS), temp out dirs, scratch DB.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { getWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { mediaReviewsConfig } from '../config.js';
import { CATEGORY_SPECS, runReviewBuild, type CategorySpec } from './build.js';

// Redirect this workflow's output dirs to a throwaway temp dir BEFORE any stage
// code runs — the specs read config at call time, so mutating the singleton
// here redirects every write (the plex-profiles build.test.ts pattern; each
// test file runs in its own process, so this can't leak).
const testOut = mkdtempSync(join(tmpdir(), 'media-reviews-build-test-'));
mediaReviewsConfig.outDir = testOut;
mediaReviewsConfig.booksOutDir = join(testOut, 'books');
mediaReviewsConfig.moviesOutDir = join(testOut, 'movies');
mediaReviewsConfig.tvOutDir = join(testOut, 'tv');
mediaReviewsConfig.albumsOutDir = join(testOut, 'albums');

function fakeCtx(logs: string[] = []): JobContext {
  return {
    log(msg) { logs.push(msg); },
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

const BOOK_1 = {
  id: 'book-0001-aaaa', title: 'Norwegian Wood', author: 'Haruki Murakami',
  rating: 4, review_text: 'Quiet and sad.', date: '15-03-2024',
};
const BOOK_2 = {
  id: 'book-0002-bbbb', title: 'Piranesi', author: 'Susanna Clarke',
  rating: 5, review_text: 'Loved it.', date: '01-02-2024',
};

test('run 1 writes files + ledger rows; run 2 (same data) skips everything', async () => {
  const scan = async () => [structuredClone(BOOK_1), structuredClone(BOOK_2)];

  const logs1: string[] = [];
  await runReviewBuild(fakeCtx(logs1), CATEGORY_SPECS.books, { scan });

  const files = readdirSync(mediaReviewsConfig.booksOutDir).sort();
  assert.equal(files.length, 2, 'one file per review');
  assert.ok(files[0].endsWith('.md'));

  const row = getWorkItem('media-reviews-books', BOOK_1.id);
  assert.equal(row?.status, 'success');
  const detail = JSON.parse(row?.detail ?? '{}') as { name?: string; markdown?: string; marker?: string };
  assert.equal(detail.name, 'Norwegian Wood (Haruki Murakami)');
  assert.ok(detail.marker && detail.marker.length === 64, 'sha256 marker stored');
  assert.ok(detail.markdown?.includes('norwegian-wood'), 'markdown path recorded');

  const written = files.map((f) => readFileSync(join(mediaReviewsConfig.booksOutDir, f), 'utf8'));
  assert.ok(written.some((c) => c.includes('Quiet and sad.')), 'review body landed in a file');

  const logs2: string[] = [];
  await runReviewBuild(fakeCtx(logs2), CATEGORY_SPECS.books, { scan });
  assert.ok(
    logs2.some((l) => l.includes('Plan: 0 to (re)write, 2 unchanged')),
    `steady-state run skips everything (got: ${logs2.join(' | ')})`,
  );
});

test('a silently backfilled field (no editedDate change) rewrites exactly that item', async () => {
  const backfilled = { ...structuredClone(BOOK_1), coverUrl: 'https://covers.example/nw.jpg' };
  const scan = async () => [backfilled, structuredClone(BOOK_2)];

  const markerBefore = (JSON.parse(getWorkItem('media-reviews-books', BOOK_1.id)?.detail ?? '{}') as { marker?: string }).marker;
  const logs: string[] = [];
  await runReviewBuild(fakeCtx(logs), CATEGORY_SPECS.books, { scan });

  assert.ok(logs.some((l) => l.includes('Plan: 1 to (re)write, 1 unchanged')), 'only the backfilled item rebuilt');
  const detail = JSON.parse(getWorkItem('media-reviews-books', BOOK_1.id)?.detail ?? '{}') as { markdown?: string; marker?: string };
  assert.notEqual(detail.marker, markerBefore, 'marker moved with the content');
  const content = readFileSync(join(mediaReviewsConfig.booksOutDir, `${'norwegian-wood-haruki-murakami'}-${BOOK_1.id.slice(0, 8)}.md`), 'utf8');
  assert.ok(content.includes('cover_url: "https://covers.example/nw.jpg"'), 'file rewritten with the backfilled field');
});

test('id-less and malformed rows are warn-skipped without failing the run', async () => {
  const scan = async () => [
    { title: 'No Id Here', author: 'Ghost' }, // no id at all
    { id: 'book-0003-cccc', title: 'No Author' }, // id but missing a required field
    structuredClone(BOOK_2),
  ];
  const logs: string[] = [];
  await runReviewBuild(fakeCtx(logs), CATEGORY_SPECS.books, { scan }); // must not throw
  assert.ok(logs.some((l) => l.includes('no usable id')), 'id-less row warned');
  assert.ok(logs.some((l) => l.includes('malformed book item book-0003-cccc')), 'malformed row warned');
  assert.equal(getWorkItem('media-reviews-books', 'book-0003-cccc'), undefined, 'malformed row gets no ledger row');
});

test('a genuine per-item failure marks the item failed and fails the run (T416)', async () => {
  const spec: CategorySpec = {
    ...CATEGORY_SPECS.albums,
    jobName: 'media-reviews-albums',
    render: (raw) => {
      if (raw.id === 'album-boom') throw new Error('render exploded');
      return CATEGORY_SPECS.albums.render(raw);
    },
  };
  const scan = async () => [
    { id: 'album-boom', title: 'Boom', artist: 'X' },
    { id: 'album-ok-1', title: 'OK Computer', artist: 'Radiohead', highlights: 'Yes.' },
  ];
  const logs: string[] = [];
  await assert.rejects(
    () => runReviewBuild(fakeCtx(logs), spec, { scan }),
    /1\/2 album review\(s\) failed/,
    'run throws when any item genuinely failed',
  );
  assert.equal(getWorkItem('media-reviews-albums', 'album-boom')?.status, 'failed');
  assert.equal(getWorkItem('media-reviews-albums', 'album-ok-1')?.status, 'success', 'other items still processed');
});

test('each category spec writes to its own out dir with its own job name', async () => {
  const movieScan = async () => [{ id: 'movie-0001', title: 'Arrival', review_text: 'Great.', tmdbDate: '2016-11-10' }];
  await runReviewBuild(fakeCtx(), CATEGORY_SPECS.movies, { scan: movieScan });
  const movieFiles = readdirSync(mediaReviewsConfig.moviesOutDir);
  assert.equal(movieFiles.length, 1);
  assert.equal(
    (JSON.parse(getWorkItem('media-reviews-movies', 'movie-0001')?.detail ?? '{}') as { name?: string }).name,
    'Arrival (2016)',
  );

  const tvScan = async () => [{ id: 'tv-0001', title: 'Mr. Robot', review_text: 'Tense.' }];
  await runReviewBuild(fakeCtx(), CATEGORY_SPECS.tv, { scan: tvScan });
  assert.equal(readdirSync(mediaReviewsConfig.tvOutDir).length, 1);
  assert.equal(getWorkItem('media-reviews-tv', 'tv-0001')?.status, 'success');
});
