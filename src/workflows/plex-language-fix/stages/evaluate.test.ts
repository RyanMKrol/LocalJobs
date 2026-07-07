// evaluate.ts tests — against a fake injected fetchItemDetail, never a real Plex server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JobContext } from '../../../core/types.js';
import { getWorkItem, markWorkItem } from '../../../db/store.js';
import type { DiscoverDetail, PlexMetadataItem, ResolveDetail } from '../types.js';
import { runEvaluate } from './evaluate.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

function seed(itemKey: string, discover: DiscoverDetail, resolve: ResolveDetail) {
  markWorkItem('plex-language-discover', itemKey, 'success', { detail: discover });
  markWorkItem('plex-language-resolve', itemKey, 'success', { detail: resolve });
}

test('evaluate records "change" when the current selection does not match the resolved language', async () => {
  seed(
    'ev-m1::part1',
    { name: 'Amelie', itemRatingKey: 'ev-m1', partId: 1, type: 'movie', tmdbId: 1 },
    { name: 'Amelie', originalLanguage: 'fr', candidateLanguages: ['fr'] },
  );

  const detail: PlexMetadataItem = {
    ratingKey: 'ev-m1',
    title: 'Amelie',
    type: 'movie',
    Media: [
      {
        id: 1,
        Part: [
          {
            id: 1,
            Stream: [
              { id: 10, streamType: 2, index: 0, languageTag: 'en', selected: true },
              { id: 11, streamType: 2, index: 1, languageTag: 'fr', channels: 2, codec: 'ac3' },
            ],
          },
        ],
      },
    ],
  };

  await runEvaluate(fakeCtx(), { fetchItemDetail: async () => detail });

  const row = getWorkItem('plex-language-evaluate', 'ev-m1::part1');
  assert.equal(row?.status, 'success');
  const parsed = JSON.parse(row!.detail!);
  assert.equal(parsed.status, 'change');
  assert.equal(parsed.proposedAudio.streamId, 11);
  assert.equal(parsed.currentAudio.streamId, 10);
  console.log('  ✓ evaluate records "change" with current + proposed captured');
});

test('evaluate records "skip" when the current selection already matches', async () => {
  seed(
    'ev-m2::part1',
    { name: 'Le Fabuleux Destin', itemRatingKey: 'ev-m2', partId: 1, type: 'movie', tmdbId: 2 },
    { name: 'Le Fabuleux Destin', originalLanguage: 'fr', candidateLanguages: ['fr'] },
  );

  const detail: PlexMetadataItem = {
    ratingKey: 'ev-m2',
    title: 'Le Fabuleux Destin',
    type: 'movie',
    Media: [{ id: 1, Part: [{ id: 1, Stream: [{ id: 20, streamType: 2, index: 0, languageTag: 'fr', selected: true }] }] }],
  };

  await runEvaluate(fakeCtx(), { fetchItemDetail: async () => detail });

  const row = getWorkItem('plex-language-evaluate', 'ev-m2::part1');
  const parsed = JSON.parse(row!.detail!);
  assert.equal(parsed.status, 'skip');
  console.log('  ✓ evaluate records "skip" when already correct');
});

test('a second run does not re-evaluate an already-evaluated file', async () => {
  seed(
    'ev-m3::part1',
    { name: 'Amour', itemRatingKey: 'ev-m3', partId: 1, type: 'movie', tmdbId: 3 },
    { name: 'Amour', originalLanguage: 'fr', candidateLanguages: ['fr'] },
  );
  const detail: PlexMetadataItem = {
    ratingKey: 'ev-m3',
    title: 'Amour',
    type: 'movie',
    Media: [{ id: 1, Part: [{ id: 1, Stream: [{ id: 30, streamType: 2, index: 0, languageTag: 'fr', selected: true }] }] }],
  };

  // Scoped by ratingKey, not a raw call count: this repo's whole test suite shares
  // one scratch DB across every *.test.ts file, so runEvaluate may legitimately
  // process other sibling tests' pending backlog in the same call.
  const callsByRatingKey = new Map<string, number>();
  const fetchItemDetail = async (ratingKey: string) => {
    callsByRatingKey.set(ratingKey, (callsByRatingKey.get(ratingKey) ?? 0) + 1);
    return ratingKey === 'ev-m3' ? detail : undefined;
  };

  await runEvaluate(fakeCtx(), { fetchItemDetail });
  assert.equal(callsByRatingKey.get('ev-m3'), 1);
  await runEvaluate(fakeCtx(), { fetchItemDetail });
  assert.equal(callsByRatingKey.get('ev-m3'), 1, 'an already-evaluated file must never be re-fetched/re-evaluated');
  console.log('  ✓ a second evaluate run does not re-evaluate an already-evaluated file');
});
