// resolve.ts tests — the injected lookupLanguageDetail stands in for a real TMDB
// call, so no network / TMDB token is ever needed. Proves the cacheKey-based
// dedup (T451/T453): a show with multiple not-yet-resolved episodes in the same
// run makes only ONE lookup call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JobContext } from '../../../core/types.js';
import { getWorkItem, markWorkItem } from '../../../db/store.js';
import { registerService } from '../../../core/services.js';
import type { TmdbLanguageDetail } from '../lib.js';
import type { DiscoverDetail } from '../types.js';
import { runResolve } from './resolve.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

function discoverRow(itemKey: string, detail: DiscoverDetail) {
  markWorkItem('plex-language-discover', itemKey, 'success', { detail });
}

registerService({ name: 'tmdb', category: 'api' });

test('a show with multiple not-yet-resolved episodes resolves via exactly ONE TMDB lookup (cacheKey dedup)', async () => {
  // A tmdb id unlikely to collide with any sibling test file's fixtures (they share
  // one scratch DB across the whole `npm test` run) — but the assertion below is
  // ALSO scoped by tmdbId, not a raw call count, so it's correct even if it does.
  const TMDB_ID = 424242;
  discoverRow('rt-e1::part1', { name: 'A Show — S01E01', itemRatingKey: 'rt-e1', partId: 1, type: 'show', tmdbId: TMDB_ID });
  discoverRow('rt-e2::part1', { name: 'A Show — S01E02', itemRatingKey: 'rt-e2', partId: 1, type: 'show', tmdbId: TMDB_ID });
  discoverRow('rt-e3::part1', { name: 'A Show — S01E03', itemRatingKey: 'rt-e3', partId: 1, type: 'show', tmdbId: TMDB_ID });

  const callsByTmdbId = new Map<number, number>();
  const fakeLookup = async (tmdbId: number): Promise<TmdbLanguageDetail> => {
    callsByTmdbId.set(tmdbId, (callsByTmdbId.get(tmdbId) ?? 0) + 1);
    return { originalLanguage: 'ja', spokenLanguages: [{ code: 'ja', name: 'Japanese' }] };
  };

  await runResolve(fakeCtx(), { lookupLanguageDetail: fakeLookup });

  assert.equal(callsByTmdbId.get(TMDB_ID), 1, 'only one real TMDB lookup should happen for 3 episodes of the same show');
  for (const key of ['rt-e1::part1', 'rt-e2::part1', 'rt-e3::part1']) {
    const row = getWorkItem('plex-language-resolve', key);
    assert.equal(row?.status, 'success');
    const detail = JSON.parse(row!.detail!);
    assert.deepEqual(detail.candidateLanguages, ['ja']);
  }
  console.log('  ✓ resolve dedups a same-title TMDB lookup across multiple episodes via cacheKey');
});

test('a second run does not re-resolve an already-resolved file', async () => {
  const TMDB_ID = 909099;
  discoverRow('rt-m1::part1', { name: 'A Movie', itemRatingKey: 'rt-m1', partId: 1, type: 'movie', tmdbId: TMDB_ID });

  const callsByTmdbId = new Map<number, number>();
  const fakeLookup = async (tmdbId: number): Promise<TmdbLanguageDetail> => {
    callsByTmdbId.set(tmdbId, (callsByTmdbId.get(tmdbId) ?? 0) + 1);
    return { originalLanguage: 'fr', spokenLanguages: [] };
  };

  await runResolve(fakeCtx(), { lookupLanguageDetail: fakeLookup });
  assert.equal(callsByTmdbId.get(TMDB_ID), 1);

  await runResolve(fakeCtx(), { lookupLanguageDetail: fakeLookup });
  assert.equal(callsByTmdbId.get(TMDB_ID), 1, 'a file already resolved must never be re-looked-up');
  console.log('  ✓ a second resolve run does not re-resolve an already-resolved file');
});
