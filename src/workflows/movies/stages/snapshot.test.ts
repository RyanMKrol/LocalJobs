// movie-snapshot stage test — hermetic: drives runSnapshot with an injected Plex
// fetch (no live Plex) and asserts what it produces: the two output files, which
// pass their artifact checks and describe every film, and no ledger rows.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { JobContext } from '../../../core/types.js';
import { registerService } from '../../../core/services.js';
import { workItemCounts } from '../../../db/store.js';
import { outputLocation } from '../../../engine/ports.js';
import { moviesConfig } from '../config.js';
import type { PlexMovieMeta } from '../types.js';
import { movieArtifacts } from '../contracts.js';
import { runSnapshot } from './snapshot.js';
import job from './snapshot.job.js';

// Redirect this workflow's output paths to a throwaway temp dir BEFORE any stage code
// runs — `runSnapshot` writes moviesConfig.snapshotOut + moviesConfig.tasteOut, which by
// default resolve to the REAL (gitignored) src/workflows/movies/data/out, so running the
// suite locally would otherwise overwrite the owner's live movie-recommendations snapshot
// + taste profile with test fixtures. The scratch-DB guard protects the DB the same way;
// this does it for the on-disk artifacts. (Each test file runs in its own process, so
// mutating the moviesConfig singleton here can't leak into another file.)
const testOut = mkdtempSync(join(tmpdir(), 'movies-snapshot-test-'));
moviesConfig.outDir = testOut;
moviesConfig.snapshotOut = join(testOut, 'snapshot.json');
moviesConfig.tasteOut = join(testOut, 'taste-profile.json');

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

describe('movie-snapshot — its outputs are the two files; it writes nothing to the ledger', () => {
  it('the stage declares both files as outputs, at the paths the run writes', () => {
    assert.deepEqual(Object.keys(job.outputs ?? {}), ['snapshot', 'taste']);
    assert.equal(job.outputs!.snapshot.artifact.key, 'movie-snapshot');
    assert.equal(job.outputs!.taste.artifact.key, 'movie-taste-profile');
    assert.equal(outputLocation(job.name, job.outputs!.snapshot), moviesConfig.snapshotOut);
    assert.equal(outputLocation(job.name, job.outputs!.taste), moviesConfig.tasteOut);
  });

  it('what a run writes passes both artifact checks, and the snapshot lists every film for the run page', async () => {
    await runSnapshot(fakeCtx(), { fetchMeta: async () => SYNTHETIC_MOVIES, now: new Date('2026-07-14T09:00:00Z') });
    const { snapshot, taste } = movieArtifacts;
    const value = snapshot.read(moviesConfig.snapshotOut);
    assert.equal(snapshot.check(value).ok, true);
    assert.equal(snapshot.summary!(value), '3 movies, 2 with a TMDB id');
    assert.deepEqual(snapshot.items!(value), [
      { id: '949', title: 'Heat (1995)', fields: [{ label: 'TMDB', value: '949' }] },
      { id: '9384', title: 'Ronin (1998)', fields: [{ label: 'TMDB', value: '9384' }] },
      { id: '3', title: 'No GUID Movie (2001)', fields: [] },
    ]);
    assert.equal(taste.check(taste.read(moviesConfig.tasteOut)).ok, true);
  });

  it('records no ledger rows: nothing is written just to be visible', async () => {
    await runSnapshot(fakeCtx(), { fetchMeta: async () => SYNTHETIC_MOVIES });
    assert.deepEqual(workItemCounts('movie-snapshot'), {});
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
