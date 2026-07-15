// discover.ts tests — against fake injected Plex fetchers only, never a real Plex server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JobContext } from '../../../core/types.js';
import { db } from '../../../db/index.js';
import { getWorkItem } from '../../../db/store.js';
import type { PlexMetadataItem, PlexSection } from '../types.js';
import { plexLanguageFixConfig } from '../config.js';
import { discoverInputKeys, fileKey, runDiscover } from './discover.js';

function fakeCtx(rootAllowed: (k: string) => boolean = () => true): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed };
}

const MOVIE_SECTION: PlexSection = { key: plexLanguageFixConfig.movieSection, type: 'movie', title: 'Movies' };
const TV_SECTION: PlexSection = { key: plexLanguageFixConfig.tvSection, type: 'show', title: 'TV shows' };

function fakes() {
  const movieDetail: PlexMetadataItem = {
    ratingKey: 'm1',
    title: 'A Movie',
    type: 'movie',
    Guid: [{ id: 'tmdb://555' }],
    Media: [{ id: 1, Part: [{ id: 9001, file: '/movies/a-movie.mkv', Stream: [] }] }],
  };
  const showDetail: PlexMetadataItem = {
    ratingKey: 's1',
    title: 'A Show',
    type: 'show',
    Guid: [{ id: 'tmdb://777' }],
  };
  const episodes: PlexMetadataItem[] = [
    {
      ratingKey: 'e1',
      title: 'Episode One',
      type: 'episode',
      parentIndex: 1,
      index: 1,
      Media: [{ id: 2, Part: [{ id: 9101, file: '/tv/a-show/s01e01.mkv', Stream: [] }] }],
    },
    {
      ratingKey: 'e2',
      title: 'Episode Two',
      type: 'episode',
      parentIndex: 1,
      index: 2,
      Media: [{ id: 3, Part: [{ id: 9102, file: '/tv/a-show/s01e02.mkv', Stream: [] }] }],
    },
  ];

  let itemDetailCalls = 0;
  return {
    itemDetailCallCount: () => itemDetailCalls,
    fetchSections: async () => [MOVIE_SECTION, TV_SECTION],
    fetchSectionItems: async (key: string, type: string) => {
      if (type === 'movie') return [{ ratingKey: 'm1', title: 'A Movie' }];
      return [{ ratingKey: 's1', title: 'A Show' }];
    },
    fetchAllLeaves: async () => episodes.map((e) => ({ ratingKey: e.ratingKey, title: e.title, index: e.index, parentIndex: e.parentIndex })),
    fetchItemDetail: async (ratingKey: string) => {
      itemDetailCalls++;
      if (ratingKey === 'm1') return movieDetail;
      if (ratingKey === 's1') return showDetail;
      return episodes.find((e) => e.ratingKey === ratingKey);
    },
  };
}

test('runDiscover records one ledger row per file, keyed by itemRatingKey::partId', async () => {
  const f = fakes();
  await runDiscover(fakeCtx(), f);

  const movieKey = fileKey('m1', 9001);
  const ep1Key = fileKey('e1', 9101);
  const ep2Key = fileKey('e2', 9102);

  assert.equal(getWorkItem('plex-language-discover', movieKey)?.status, 'success');
  assert.equal(getWorkItem('plex-language-discover', ep1Key)?.status, 'success');
  assert.equal(getWorkItem('plex-language-discover', ep2Key)?.status, 'success');

  const movieDetail = JSON.parse(getWorkItem('plex-language-discover', movieKey)!.detail!);
  assert.equal(movieDetail.tmdbId, 555);
  assert.equal(movieDetail.type, 'movie');

  const epDetail = JSON.parse(getWorkItem('plex-language-discover', ep1Key)!.detail!);
  assert.equal(epDetail.tmdbId, 777);
  assert.equal(epDetail.type, 'show');
  assert.equal(epDetail.seasonEpisode, 'S01E01');

  // Scoped containment, not exact-equality: this repo's whole test suite shares one
  // scratch DB across every *.test.ts file, so the job's ledger can legitimately
  // carry rows from unrelated sibling tests by the time this assertion runs.
  const known = new Set(await discoverInputKeys(f));
  for (const key of [movieKey, ep1Key, ep2Key]) assert.ok(known.has(key), `expected ${key} to be discovered`);
  console.log('  ✓ runDiscover records one ledger row per file');
});

test('a second run does not re-mark an already-known file (ledger row count unchanged)', async () => {
  const f = fakes();
  await runDiscover(fakeCtx(), f); // seeds the ledger again with the same fixture (idempotent upsert)
  const before = (await discoverInputKeys(f)).length;

  await runDiscover(fakeCtx(), f);
  const after = (await discoverInputKeys(f)).length;

  assert.equal(after, before, 'ledger key count must not grow on a re-run over the same fixture');
  console.log('  ✓ a second discover run over the same fixture does not grow the ledger');
});

test('discoverInputKeys returns the live candidate set from a Plex walk, not a ledger read-back — survives a reset ledger (T485)', async () => {
  const f = fakes();
  // Seed the ledger via a normal discover run, exactly like a prior week's run would.
  await runDiscover(fakeCtx(), f);

  const movieKey = fileKey('m1', 9001);
  const ep1Key = fileKey('e1', 9101);
  const ep2Key = fileKey('e2', 9102);
  assert.equal(getWorkItem('plex-language-discover', movieKey)?.status, 'success');

  // Simulate "Clear output data" wiping this job's own ledger rows — the exact trap
  // the old ledgerSuccessRows(JOB_NAME)-based implementation fell into: reading its
  // own now-empty ledger back would silently return [].
  db.prepare(`DELETE FROM work_items WHERE job_name = 'plex-language-discover'`).run();
  assert.equal(getWorkItem('plex-language-discover', movieKey), undefined, 'ledger row must actually be gone');

  const keys = await discoverInputKeys(f);
  const found = new Set(keys);
  for (const key of [movieKey, ep1Key, ep2Key]) {
    assert.ok(found.has(key), `expected ${key} from a live Plex walk despite an empty ledger`);
  }
  console.log('  ✓ discoverInputKeys re-discovers the full candidate set live after a ledger reset');
});
