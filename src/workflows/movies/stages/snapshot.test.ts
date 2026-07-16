// movie-snapshot stage test — hermetic: drives runSnapshot with an injected Plex
// fetch (no live Plex) and asserts the per-movie visibility ledger rows it
// records (T605) have the expected shape: one row per movie, keyed by
// tmdbId-or-ratingKey, detail { name, tmdbId, year }.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { JobContext } from '../../../core/types.js';
import { registerService } from '../../../core/services.js';
import { getWorkItem, workItemCounts } from '../../../db/store.js';
import type { PlexMovieMeta } from '../types.js';
import { recordSnapshotLedger, runSnapshot, SNAPSHOT_JOB, snapshotItemKey } from './snapshot.js';

function fakeCtx(): JobContext {
  return {
    log() {},
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

const SYNTHETIC_MOVIES: PlexMovieMeta[] = [
  { title: 'Heat', year: 1995, ratingKey: '1', Guid: [{ id: 'tmdb://949' }], Genre: [{ tag: 'Crime' }] },
  { title: 'Ronin', year: 1998, ratingKey: '2', Guid: [{ id: 'tmdb://9384' }], Genre: [{ tag: 'Action' }] },
  { title: 'No GUID Movie', year: 2001, ratingKey: '3', Genre: [{ tag: 'Drama' }] },
];

describe('movie-snapshot — per-movie visibility ledger rows (T605)', () => {
  it('snapshotItemKey prefers tmdbId, falls back to ratingKey', () => {
    assert.equal(snapshotItemKey({ tmdbId: 949, ratingKey: '1' }), '949');
    assert.equal(snapshotItemKey({ tmdbId: null, ratingKey: 'noguid' }), 'noguid');
  });

  it('records one success row per movie, keyed + detailed correctly', async () => {
    recordSnapshotLedger([
      { title: 'Heat', year: 1995, tmdbId: 949, ratingKey: '1', genres: ['Crime'], directors: [], countries: [], audienceRating: null, rating: null },
      { title: 'No GUID Movie', year: 2001, tmdbId: null, ratingKey: '3', genres: ['Drama'], directors: [], countries: [], audienceRating: null, rating: null },
    ]);

    const row1 = getWorkItem(SNAPSHOT_JOB, '949');
    assert.ok(row1, 'a row is recorded for the GUID-matched movie');
    assert.equal(row1!.status, 'success');
    assert.deepEqual(JSON.parse(row1!.detail!), { name: 'Heat', tmdbId: 949, year: 1995 });

    const row2 = getWorkItem(SNAPSHOT_JOB, '3');
    assert.ok(row2, 'a row is recorded for the GUID-less movie too, keyed by ratingKey');
    assert.equal(row2!.status, 'success');
    assert.deepEqual(JSON.parse(row2!.detail!), { name: 'No GUID Movie', tmdbId: null, year: 2001 });
  });

  it('runSnapshot records one row per movie matching the fetched count', async () => {
    // Distinct, non-overlapping keys from every other test in this file, so the
    // total-row assertion below isn't coupled to insertion order across tests.
    const runMovies: PlexMovieMeta[] = [
      { title: 'The Insider', year: 1999, ratingKey: 'r-501', Guid: [{ id: 'tmdb://501' }], Genre: [{ tag: 'Drama' }] },
      { title: 'Collateral', year: 2004, ratingKey: 'r-502', Guid: [{ id: 'tmdb://502' }], Genre: [{ tag: 'Thriller' }] },
      { title: 'Unmatched Movie', year: 2010, ratingKey: 'r-503', Genre: [{ tag: 'Drama' }] },
    ];
    const now = new Date('2026-07-14T09:00:00Z');
    await runSnapshot(fakeCtx(), { fetchMeta: async () => runMovies, now });

    let matched = 0;
    for (const m of runMovies) {
      const key = m.Guid?.[0]?.id?.startsWith('tmdb://') ? m.Guid[0].id.replace('tmdb://', '') : String(m.ratingKey);
      const row = getWorkItem(SNAPSHOT_JOB, key);
      assert.ok(row, `a row exists for movie "${m.title}" keyed "${key}"`);
      assert.equal(row!.status, 'success');
      matched += 1;
    }
    assert.equal(matched, runMovies.length, 'a ledger row was recorded for every fetched movie');
  });

  it('upserts the same rows on a re-run (no duplicate rows per movie)', async () => {
    const runMovies: PlexMovieMeta[] = [
      { title: 'The Third Man', year: 1949, ratingKey: 'r-601', Guid: [{ id: 'tmdb://601' }], Genre: [{ tag: 'Noir' }] },
      { title: 'Chinatown', year: 1974, ratingKey: 'r-602', Guid: [{ id: 'tmdb://602' }], Genre: [{ tag: 'Noir' }] },
    ];
    const now = new Date('2026-07-14T18:00:00Z');
    await runSnapshot(fakeCtx(), { fetchMeta: async () => runMovies, now });
    const afterFirst = workItemCounts(SNAPSHOT_JOB).success;
    await runSnapshot(fakeCtx(), { fetchMeta: async () => runMovies, now });
    const afterSecond = workItemCounts(SNAPSHOT_JOB).success;
    assert.equal(afterSecond, afterFirst, 're-running with the same movies does not grow the ledger row count');
  });
});

describe('movie-snapshot — Plex reads are cacheKey-deduped (T477)', () => {
  it('a second run within the TTL does not re-invoke the underlying Plex GET', async () => {
    registerService({ name: 'plex', category: 'api' });

    const callsByPath = new Map<string, number>();
    const plexFetch = async <T,>(path: string): Promise<T> => {
      callsByPath.set(path, (callsByPath.get(path) ?? 0) + 1);
      return { MediaContainer: { Metadata: SYNTHETIC_MOVIES } } as T;
    };

    await runSnapshot(fakeCtx(), { plexFetch, now: new Date('2026-07-15T09:00:00Z') });
    await runSnapshot(fakeCtx(), { plexFetch, now: new Date('2026-07-15T10:00:00Z') });

    assert.equal(callsByPath.size, 1, 'exactly one distinct Plex path was requested');
    for (const [path, count] of callsByPath) {
      assert.equal(count, 1, `path "${path}" should be fetched only once across two runs within the cache TTL`);
    }
  });
});
