// build.ts tests — verify callService('plex', ...) wrapper + pass-through in test env
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { callService, registerService } from '../../../core/services.js';
import type { JobContext } from '../../../core/types.js';
import { plexProfilesConfig } from '../config.js';
import { runBuild } from './build.js';

// Redirect this workflow's output dirs to a throwaway temp dir BEFORE any stage code
// runs — `runBuild` writes one markdown profile per title into
// plexProfilesConfig.moviesOutDir/showsOutDir, which by default resolve to the REAL
// (gitignored) src/workflows/plex-profiles/data/out, so running the suite locally would
// otherwise write test-fixture profiles into the owner's real profile corpus. The
// scratch-DB guard protects the DB the same way; this does it for the on-disk artifacts.
// (Each test file runs in its own process, so mutating the singleton here can't leak.)
const testOut = mkdtempSync(join(tmpdir(), 'plex-profiles-build-test-'));
plexProfilesConfig.outDir = testOut;
plexProfilesConfig.moviesOutDir = join(testOut, 'movies');
plexProfilesConfig.showsOutDir = join(testOut, 'shows');

// ── callService('plex', ...) wrapper — pass-through when service unregistered ──
{
  let fnCalled = false;
  const result = await callService('plex', async () => {
    fnCalled = true;
    return { data: 'test', value: 42 };
  });
  assert.ok(fnCalled, 'callService passes through when plex service is unregistered in tests');
  assert.equal(result.data, 'test', 'result is returned unchanged');
  assert.equal(result.value, 42, 'result properties are preserved');
  console.log('  ✓ callService(\'plex\', ...) pass-through wrapper works (unregistered service in test)');
}

test('callService plex wrapper preserves return value and error handling', async () => {
  let callCount = 0;
  const results = [];

  // Test successful call
  const successResult = await callService('plex', async () => {
    callCount++;
    return { success: true };
  });
  results.push(successResult);
  assert.equal(callCount, 1, 'function was called once');
  assert.deepEqual(successResult, { success: true }, 'success result returned unchanged');

  // Test error propagation
  const testError = new Error('test plex error');
  await assert.rejects(
    () => callService('plex', async () => {
      callCount++;
      throw testError;
    }),
    testError,
    'errors are propagated correctly',
  );
  assert.equal(callCount, 2, 'function was called twice total');

  console.log('  ✓ callService(\'plex\', ...) preserves return values and errors');
});

// ── T477: Plex reads pass a cacheKey and reuse the 3-hour service_cache ──
function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

test('runBuild dedups a second call sharing a cacheKey within the TTL (section listings + per-title detail)', async () => {
  registerService({ name: 'plex', category: 'api' });

  const callsByPath = new Map<string, number>();
  const plexFetch = async <T,>(path: string): Promise<T> => {
    callsByPath.set(path, (callsByPath.get(path) ?? 0) + 1);
    if (path.startsWith('/library/metadata/')) {
      return { MediaContainer: { Metadata: [{ ratingKey: 'm477', title: 'Cache Test Movie', updatedAt: 1 }] } } as T;
    }
    if (path.includes('type=4')) {
      return { MediaContainer: { Metadata: [] } } as T;
    }
    // Movie/show section listings — one movie candidate, no shows.
    return { MediaContainer: { Metadata: path.includes(`sections/4`) ? [{ ratingKey: 'm477', title: 'Cache Test Movie', updatedAt: 1 }] : [] } } as T;
  };

  await runBuild(fakeCtx(), { plexFetch });
  await runBuild(fakeCtx(), { plexFetch });

  assert.equal(callsByPath.size, 4, 'four distinct Plex paths were requested (movies/shows/episodes listings + one detail fetch)');
  for (const [path, count] of callsByPath) {
    assert.equal(count, 1, `path "${path}" should be fetched only once across two runs within the cache TTL`);
  }
});
