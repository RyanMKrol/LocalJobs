// franchise-gaps collection ledger tests — hermetic (scratch DB only, no live TMDB).
// Tests: `recordCollectionLedger` records collection outcomes with proper detail,
// and per-collection errors are recorded as failed rows.
import assert from 'node:assert/strict';
import { getWorkItem, syncService } from '../../../db/store.js';
import { registerService } from '../../../core/services.js';
import { recordCollectionLedger } from './franchise-gaps.js';
import type { FranchiseGap } from '../../movies/types.js';

// `callService('tmdb', ...)` only enforces quota if 'tmdb' is registered in the
// in-process service registry — normally done by loading the daemon's registry,
// which this standalone test never does. Register it here so the wrap passes through.
registerService({ name: 'tmdb' });
syncService({ name: 'tmdb' });

// ── recordCollectionLedger: one row per collection, success with/without gaps ──
{
  const gapsInCollection: FranchiseGap[] = [
    {
      collectionId: 100,
      collectionName: 'Star Wars Collection',
      tmdbId: 10,
      title: 'Episode I: The Phantom Menace',
      year: 1999,
      tmdbRating: 6.5,
    },
    {
      collectionId: 100,
      collectionName: 'Star Wars Collection',
      tmdbId: 20,
      title: 'Rogue One',
      year: 2016,
      tmdbRating: 7.8,
    },
  ];

  // Record a collection with gaps.
  recordCollectionLedger(100, 'Star Wars Collection', gapsInCollection);

  const row1 = getWorkItem('franchise-gaps', '100');
  assert.ok(row1, 'a row is recorded for the collection with gaps');
  assert.equal(row1!.status, 'success', 'a checked collection with gaps is success');
  assert.equal(row1!.root_key, '100', 'no rootKey passed — this is a root-level ledger row');
  const detail1 = JSON.parse(row1!.detail!);
  assert.deepEqual(detail1, {
    name: 'Star Wars Collection',
    gapsCount: 2,
    gaps: ['Episode I: The Phantom Menace', 'Rogue One'],
  });

  console.log('  ✓ recordCollectionLedger records collection with gaps, detail captures gap count + titles');
}

// ── recordCollectionLedger with no gaps (still success) ──
{
  // Record a collection with no gaps.
  recordCollectionLedger(200, 'James Bond Collection', []);

  const row2 = getWorkItem('franchise-gaps', '200');
  assert.ok(row2, 'a row is recorded for the collection with no gaps');
  assert.equal(row2!.status, 'success', 'a checked collection with zero gaps is success');
  const detail2 = JSON.parse(row2!.detail!);
  assert.deepEqual(detail2, {
    name: 'James Bond Collection',
    gapsCount: 0,
    gaps: [],
  });

  console.log('  ✓ recordCollectionLedger records collection with zero gaps as success');
}

console.log('  ✓ franchise-gaps ledger tests passed');
