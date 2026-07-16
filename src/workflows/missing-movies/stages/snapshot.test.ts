// Stage 1 ledger tests — hermetic (scratch DB only, no live Plex). `runSnapshot`
// itself is not exercised here (it drives `plexGet` wrapped in `callService('plex', ...)`,
// which resolves the Plex host over the network — untestable hermetically, matching every
// other Plex-touching workflow's snapshot stage in this repo, none of which unit-test that
// wrapper). Instead this covers the actual NEW behaviour this task added: `recordSnapshotLedger`,
// the per-movie work_items ledger recording extracted out of `runSnapshot` so it can be
// tested directly against synthetic movie snapshots.
import assert from 'node:assert/strict';
import type { JobContext } from '../../../core/types.js';
import { getWorkItem, syncService } from '../../../db/store.js';
import { registerService } from '../../../core/services.js';
import { recordSnapshotLedger, snapshotItemKey } from './snapshot.js';
import type { PlexMovie } from '../../movies/types.js';

// `callService('plex', ...)` only enforces quota if 'plex' is registered in the
// in-process service registry — normally done by loading the daemon's registry,
// which this standalone test never does. Register it here so the wrap passes through.
registerService({ name: 'plex' });
syncService({ name: 'plex' });

function movie(overrides: Partial<PlexMovie> = {}): PlexMovie {
  return {
    title: 'Some Movie',
    year: 2020,
    tmdbId: 615,
    ratingKey: 'r1',
    genres: [],
    directors: [],
    countries: [],
    audienceRating: null,
    rating: null,
    ...overrides,
  };
}

// ── snapshotItemKey: tmdbId preferred, ratingKey fallback ──
assert.equal(snapshotItemKey(movie({ tmdbId: 615, ratingKey: 'r1' })), '615', 'prefers the tmdbId when present');
assert.equal(snapshotItemKey(movie({ tmdbId: null, ratingKey: 'noguid' })), 'noguid', 'falls back to ratingKey with no tmdbId');
console.log('  ✓ snapshotItemKey prefers tmdbId, falls back to ratingKey');

// ── recordSnapshotLedger: one row per movie, keyed + detailed correctly ──
{
  const withGuid = movie({ title: 'Avatar', tmdbId: 19995, ratingKey: 'avatar-2009', year: 2009 });
  const noGuid = movie({ title: 'Unknown Film', tmdbId: null, ratingKey: 'noguid-123', year: null });
  recordSnapshotLedger([withGuid, noGuid]);

  const row1 = getWorkItem('plex-movie-snapshot', '19995');
  assert.ok(row1, 'a row is recorded for the GUID-matched movie');
  assert.equal(row1!.status, 'success', 'always success — snapshotting itself never fails per-movie');
  assert.equal(row1!.root_key, '19995', 'no rootKey/parentKey passed — this is the root stage, root_key defaults to item_key');
  const detail1 = JSON.parse(row1!.detail!);
  assert.deepEqual(detail1, { name: 'Avatar', tmdbId: 19995, year: 2009 });

  const row2 = getWorkItem('plex-movie-snapshot', 'noguid-123');
  assert.ok(row2, 'a row is recorded for the GUID-less movie too');
  assert.equal(row2!.status, 'success', 'a movie with no tmdb:// GUID is still a successfully-snapshotted state');
  const detail2 = JSON.parse(row2!.detail!);
  assert.deepEqual(detail2, { name: 'Unknown Film', tmdbId: null, year: null });

  console.log('  ✓ recordSnapshotLedger records one success row per movie, keyed + detailed correctly');
}

console.log('  ✓ plex-movie-snapshot ledger tests passed');
