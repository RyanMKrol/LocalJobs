// Stage 1 ledger tests — hermetic (scratch DB only, no live Plex). `runSnapshot`
// itself is not exercised here (it drives `plexGet` wrapped in `callService('plex', ...)`,
// which resolves the Plex host over the network — untestable hermetically, matching every
// other Plex-touching workflow's snapshot stage in this repo, none of which unit-test that
// wrapper). Instead this covers the actual NEW behaviour this task added: `recordSnapshotLedger`,
// the per-show work_items ledger recording extracted out of `runSnapshot` so it can be
// tested directly against synthetic show snapshots.
import assert from 'node:assert/strict';
import { getWorkItem, syncService } from '../../../db/store.js';
import { registerService } from '../../../core/services.js';
import { recordSnapshotLedger, snapshotItemKey } from './snapshot.js';
import type { PlexShow } from '../types.js';

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

console.log('  ✓ plex-tv-snapshot ledger tests passed');
