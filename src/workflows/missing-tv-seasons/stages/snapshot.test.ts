// Stage 1 ledger tests — hermetic (scratch DB only, no live Plex). `runSnapshot`
// itself is not exercised here (it drives `plexGet` wrapped in `callService('plex', ...)`,
// which resolves the Plex host over the network — untestable hermetically, matching every
// other Plex-touching workflow's snapshot stage in this repo, none of which unit-test that
// wrapper). Instead this covers the actual NEW behaviour this task added: `recordSnapshotLedger`,
// the per-show work_items ledger recording extracted out of `runSnapshot` so it can be
// tested directly against synthetic show snapshots.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobContext } from '../../../core/types.js';
import { clearServiceCache, getWorkItem, syncService } from '../../../db/store.js';
import { registerService } from '../../../core/services.js';
import { plexConfig } from '../config.js';
import { recordSnapshotLedger, runSnapshot, snapshotItemKey } from './snapshot.js';
import type { PlexShow } from '../types.js';

// Redirect this workflow's output paths to a throwaway temp dir BEFORE any stage code
// runs. `runSnapshot` writes plexConfig.snapshotOut, which by default resolves to the
// REAL (gitignored) src/workflows/missing-tv-seasons/data/out/snapshot.json — so running
// the suite locally would otherwise overwrite the owner's live Plex snapshot with this
// test's fixtures. The scratch-DB guard protects the DB the same way; this does it for
// the on-disk artifacts. (Each test file runs in its own process, so mutating the
// plexConfig singleton here can't leak into another file.)
const testOut = mkdtempSync(join(tmpdir(), 'missing-tv-snapshot-test-'));
plexConfig.outDir = testOut;
plexConfig.snapshotOut = join(testOut, 'snapshot.json');
plexConfig.missingOut = join(testOut, 'missing-seasons.json');
plexConfig.reportDir = join(testOut, 'reports');

// `callService('plex', ...)` only enforces quota if 'plex' is registered in the
// in-process service registry — normally done by loading the daemon's registry,
// which this standalone test never does. Register it here so the wrap passes through.
registerService({ name: 'plex' });
syncService({ name: 'plex' });

function show(overrides: Partial<PlexShow> = {}): PlexShow {
  return {
    title: 'Some Show',
    year: 2020,
    tmdbId: 615,
    ratingKey: 'r1',
    highestOwnedSeason: 3,
    ...overrides,
  };
}

// ── snapshotItemKey: tmdbId preferred, ratingKey fallback ──
assert.equal(snapshotItemKey(show({ tmdbId: 615, ratingKey: 'r1' })), '615', 'prefers the tmdbId when present');
assert.equal(snapshotItemKey(show({ tmdbId: null, ratingKey: 'noguid' })), 'noguid', 'falls back to ratingKey with no tmdbId');
console.log('  ✓ snapshotItemKey prefers tmdbId, falls back to ratingKey');

// ── recordSnapshotLedger: one row per show, keyed + detailed correctly ──
{
  const withGuid = show({ title: 'Futurama', tmdbId: 9990615, ratingKey: 'futurama', highestOwnedSeason: 7 });
  const noGuid = show({ title: 'No GUID Show', tmdbId: null, ratingKey: 'noguid-9990615', highestOwnedSeason: 2 });
  recordSnapshotLedger([withGuid, noGuid]);

  const row1 = getWorkItem('plex-tv-snapshot', '9990615');
  assert.ok(row1, 'a row is recorded for the GUID-matched show');
  assert.equal(row1!.status, 'success', 'always success — snapshotting itself never fails per-show');
  assert.equal(row1!.root_key, '9990615', 'no rootKey/parentKey passed — this is the root stage, root_key defaults to item_key');
  const detail1 = JSON.parse(row1!.detail!);
  assert.deepEqual(detail1, { name: 'Futurama', tmdbId: 9990615, highestOwnedSeason: 7 });

  const row2 = getWorkItem('plex-tv-snapshot', 'noguid-9990615');
  assert.ok(row2, 'a row is recorded for the GUID-less show too');
  assert.equal(row2!.status, 'success', 'a show with no tmdb:// GUID is still a successfully-snapshotted state');
  const detail2 = JSON.parse(row2!.detail!);
  assert.deepEqual(detail2, { name: 'No GUID Show', tmdbId: null, highestOwnedSeason: 2 });

  console.log('  ✓ recordSnapshotLedger records one success row per show, keyed + detailed correctly');
}

// ── T477: Plex reads pass a cacheKey and reuse the 3-hour service_cache ──
{
  registerService({ name: 'plex', category: 'api' });

  function fakeCtx(): JobContext {
    return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
  }

  const callsByPath = new Map<string, number>();
  const fakeFetchPlex = async <T,>(path: string): Promise<T> => {
    callsByPath.set(path, (callsByPath.get(path) ?? 0) + 1);
    // The shows-listing path (?includeGuids=1) must return ≥1 show so the new
    // "fail on 0 shows" guard passes; the episode path (?type=4) can be empty.
    const Metadata = path.includes('type=4')
      ? []
      : [{ title: 'Cached Show', ratingKey: 'cache-r1', Guid: [{ id: 'tmdb://615' }] }];
    return { MediaContainer: { Metadata } } as T;
  };

  await runSnapshot(fakeCtx(), { fetchPlex: fakeFetchPlex });
  await runSnapshot(fakeCtx(), { fetchPlex: fakeFetchPlex });

  assert.equal(callsByPath.size, 2, 'two distinct Plex paths were requested (shows listing + episode listing)');
  for (const [path, count] of callsByPath) {
    assert.equal(count, 1, `path "${path}" should be fetched only once across two runs within the cache TTL`);
  }
  console.log('  ✓ plex-tv-snapshot Plex reads are cacheKey-deduped across runs (T477)');
}

// ── Fail loud on a 0-show read (never clobber good output with an empty snapshot) ──
{
  registerService({ name: 'plex', category: 'api' });
  const ctx: JobContext = { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
  // Clear the cache the T477 test above populated for section 5's shows path — otherwise
  // this run gets a cache HIT (a non-empty show) and never reaches emptyFetch.
  clearServiceCache('plex');
  // Shows-listing path returns empty → the guard must throw before anything is written.
  const emptyFetch = async <T,>(): Promise<T> => ({ MediaContainer: { Metadata: [] } } as T);
  await assert.rejects(
    runSnapshot(ctx, { fetchPlex: emptyFetch }),
    /returned 0 shows/,
    'runSnapshot throws on a 0-show Plex read instead of writing an empty snapshot',
  );
  console.log('  ✓ plex-tv-snapshot fails loud on a 0-show read (no empty-snapshot clobber)');
}

console.log('  ✓ plex-tv-snapshot ledger tests passed');
