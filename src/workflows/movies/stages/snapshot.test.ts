// movie-snapshot stage test — hermetic: drives runSnapshot with an injected Plex
// fetch (no live Plex) and asserts the single combined per-run visibility ledger
// row it records (T571) has the expected shape: { name, movies, path, format }.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { JobContext } from '../../../core/types.js';
import { registerService } from '../../../core/services.js';
import { getWorkItem } from '../../../db/store.js';
import { toStoredPath } from '../../../db/store/lib.js';
import { moviesConfig } from '../config.js';
import type { PlexMovieMeta } from '../types.js';
import { dayKey } from '../../../core/dates.js';
import { runSnapshot, SNAPSHOT_JOB } from './snapshot.js';

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

describe('movie-snapshot — combined per-run visibility ledger row (T571)', () => {
  it('records exactly one success row keyed by ISO date, describing the snapshot', async () => {
    const now = new Date('2026-07-14T09:00:00Z');
    await runSnapshot(fakeCtx(), { fetchMeta: async () => SYNTHETIC_MOVIES, now });

    const row = getWorkItem(SNAPSHOT_JOB, dayKey(now));
    assert.ok(row, 'a work_items row was recorded for movie-snapshot');
    assert.equal(row.status, 'success');

    const detail = JSON.parse(row.detail ?? 'null') as {
      name?: string; movies?: number; path?: string; format?: string;
    };
    assert.equal(detail.name, 'Movie library snapshot');
    assert.equal(detail.movies, SYNTHETIC_MOVIES.length, 'movies count equals the fetched count');
    assert.equal(detail.format, 'json');
    // Path is normalized workflows-root-relative (T447), never a raw absolute path.
    assert.equal(detail.path, toStoredPath(moviesConfig.snapshotOut));
    assert.ok(!detail.path?.startsWith('/'), 'path is stored relative, not absolute');
  });

  it('upserts the same row on a same-day re-run (one row per run, not per movie)', async () => {
    const now = new Date('2026-07-14T18:00:00Z');
    await runSnapshot(fakeCtx(), { fetchMeta: async () => SYNTHETIC_MOVIES.slice(0, 1), now });
    const row = getWorkItem(SNAPSHOT_JOB, dayKey(now));
    assert.ok(row);
    const detail = JSON.parse(row.detail ?? 'null') as { movies?: number };
    assert.equal(detail.movies, 1, 're-run overwrote the row with the fresh count');
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

    await runSnapshot(fakeCtx(), { plexFetch, now: new Date('2026-07-14T09:00:00Z') });
    await runSnapshot(fakeCtx(), { plexFetch, now: new Date('2026-07-14T10:00:00Z') });

    assert.equal(callsByPath.size, 1, 'exactly one distinct Plex path was requested');
    for (const [path, count] of callsByPath) {
      assert.equal(count, 1, `path "${path}" should be fetched only once across two runs within the cache TTL`);
    }
  });
});
