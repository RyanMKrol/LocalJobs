import test from 'node:test';
import assert from 'node:assert/strict';
import { recordIngestLedger } from './ingest.js';
import { isWorkItemDone, workItemCounts } from '../../../db/store.js';
import type { NormalizedPlace } from '../types.js';

// Convention: the FIRST workflow stage owns the per-item ledger list. places-ingest
// records one work_item per CID-bearing place (keyed by CID) so idempotency + the
// run's Input→Output mapping are anchored from stage one.

const place = (cid: string | null, name: string): NormalizedPlace =>
  ({ cid, cidHex: null, featureId: null, name, url: '', cidUrl: null, lists: ['Saved'] } as unknown as NormalizedPlace);

await test('places-ingest records a work_item per CID-bearing place (name-only skipped)', () => {
  recordIngestLedger([
    place('cid-100', 'Alpha Cafe'),
    place('cid-200', 'Beta Bakery'),
    place(null, 'Name Only Spot'), // no CID — never enters the pipeline, not recorded
  ]);

  const counts = workItemCounts(INGEST_JOB());
  assert.equal(counts.success ?? 0, 2, 'exactly the two CID-bearing places are recorded as success');
  // Keyed by CID, so a downstream stage sees them as done.
  assert.equal(isWorkItemDone(INGEST_JOB(), 'cid-100', 4), true);
  assert.equal(isWorkItemDone(INGEST_JOB(), 'cid-200', 4), true);
  assert.equal(isWorkItemDone(INGEST_JOB(), 'cid-missing', 4), false);
});

await test('places-ingest honours the run limit — records only rootAllowed CIDs', () => {
  // A limited run freezes selected roots; ctx.rootAllowed(cid) gates them. Ingest
  // must scope its ledger to the selected subset (so the IO mapping reflects the
  // limit), even though it still writes the full places.json catalog.
  const allowed = new Set(['cid-keep']);
  recordIngestLedger(
    [place('cid-keep', 'Kept'), place('cid-skip-1', 'Skipped 1'), place('cid-skip-2', 'Skipped 2')],
    (cid) => allowed.has(cid),
  );
  assert.equal(isWorkItemDone(INGEST_JOB(), 'cid-keep', 4), true, 'selected root recorded');
  assert.equal(isWorkItemDone(INGEST_JOB(), 'cid-skip-1', 4), false, 'non-selected root NOT recorded');
  assert.equal(isWorkItemDone(INGEST_JOB(), 'cid-skip-2', 4), false, 'non-selected root NOT recorded');
});

// The job name is private to ingest.ts; mirror it here for the assertions.
function INGEST_JOB(): string {
  return 'places-ingest';
}
