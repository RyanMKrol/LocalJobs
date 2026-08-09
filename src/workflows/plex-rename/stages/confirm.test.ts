// confirm.ts tests — injected apply rows + fake live Plex fetch; scratch-DB ledger.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JobContext } from '../../../core/types.js';
import { getWorkItem } from '../../../db/store.js';
import type { ApplyDetail, ConfirmDetail, PlexMetadataItem } from '../types.js';
import { runConfirm } from './confirm.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

const NOW = new Date('2026-08-09T05:00:00.000Z');
const TO = '/volume1/Share/Movies/A Movie (2016) {tmdb-1}/A Movie (2016) {tmdb-1}.mkv';
const OLD = '/volume1/Share/Movies/Rel/old.mkv';

let n = 0;
function applyRow(over: Partial<ApplyDetail> = {}) {
  n++;
  const itemKey = `rk${n}::part${n}`;
  return {
    itemKey,
    ratingKey: `rk${n}`,
    partId: n,
    detail: {
      name: `Movie ${n}`,
      from: OLD,
      to: TO,
      sha256: 'x'.repeat(64),
      bytes: 11,
      sidecarCount: 0,
      appliedAt: '2026-08-08T05:00:00.000Z', // 1 day before NOW — inside the 14d grace
      ...over,
    } as ApplyDetail,
  };
}

function plexItem(ratingKey: string, partId: number, file: string): PlexMetadataItem {
  return { ratingKey, title: 'A Movie', type: 'movie', Media: [{ id: 1, Part: [{ id: partId, file }] }] };
}

function confirmOf(itemKey: string): { status?: string; detail: ConfirmDetail } {
  const row = getWorkItem('plex-rename-confirm', itemKey);
  assert.ok(row, `expected a confirm row for ${itemKey}`);
  return { status: row!.status, detail: JSON.parse(row!.detail!) as ConfirmDetail };
}

test('confirm: same ratingKey at the new path → confirmed once-ever', async () => {
  const row = applyRow();
  await runConfirm(fakeCtx(), {
    readApplyRows: () => [{ itemKey: row.itemKey, detail: row.detail }],
    fetchItemDetail: async () => plexItem(row.ratingKey, row.partId, TO),
    now: () => NOW,
  });
  const c = confirmOf(row.itemKey);
  assert.equal(c.status, 'success');
  assert.equal(c.detail.confirmed, true);
  assert.equal(c.detail.confirmedPath, TO);
});

test('confirm: old path within grace → soft pending, re-checked; past grace → fails loud', async () => {
  const inGrace = applyRow();
  await runConfirm(fakeCtx(), {
    readApplyRows: () => [{ itemKey: inGrace.itemKey, detail: inGrace.detail }],
    fetchItemDetail: async () => plexItem(inGrace.ratingKey, inGrace.partId, OLD),
    graceDays: 14,
    now: () => NOW,
  });
  const pending = confirmOf(inGrace.itemKey);
  assert.equal(pending.status, 'skipped', 'retryable — next run re-checks');
  assert.equal(pending.detail.reason, 'pending-rescan');

  const stale = applyRow({ appliedAt: '2026-07-01T00:00:00.000Z' }); // 39 days before NOW
  await assert.rejects(
    runConfirm(fakeCtx(), {
      readApplyRows: () => [{ itemKey: stale.itemKey, detail: stale.detail }],
      fetchItemDetail: async () => plexItem(stale.ratingKey, stale.partId, OLD),
      graceDays: 14,
      now: () => NOW,
    }),
    /1 renamed item\(s\) failed confirmation/,
  );
  const failed = confirmOf(stale.itemKey);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.detail.reason, 'grace-exceeded');
});

test('confirm: vanished ratingKey (possible duplicate re-import) fails loud immediately', async () => {
  const row = applyRow();
  await assert.rejects(
    runConfirm(fakeCtx(), {
      readApplyRows: () => [{ itemKey: row.itemKey, detail: row.detail }],
      fetchItemDetail: async () => undefined,
      now: () => NOW,
    }),
    /failed confirmation/,
  );
  const c = confirmOf(row.itemKey);
  assert.equal(c.status, 'failed');
  assert.equal(c.detail.reason, 'ratingkey-gone');
});

test('confirm: transient fetch error is soft (skipped, retried), and a confirmed item is never re-fetched', async () => {
  const row = applyRow();
  let calls = 0;
  const fetchFail = async () => {
    calls++;
    throw new Error('ECONNREFUSED');
  };
  await runConfirm(fakeCtx(), {
    readApplyRows: () => [{ itemKey: row.itemKey, detail: row.detail }],
    fetchItemDetail: fetchFail,
    now: () => NOW,
  }); // must not throw — transient
  assert.equal(confirmOf(row.itemKey).status, 'skipped');

  // Now it confirms; a further run must not fetch again (once-ever success).
  await runConfirm(fakeCtx(), {
    readApplyRows: () => [{ itemKey: row.itemKey, detail: row.detail }],
    fetchItemDetail: async () => plexItem(row.ratingKey, row.partId, TO),
    now: () => NOW,
  });
  assert.equal(confirmOf(row.itemKey).status, 'success');
  let extraCalls = 0;
  await runConfirm(fakeCtx(), {
    readApplyRows: () => [{ itemKey: row.itemKey, detail: row.detail }],
    fetchItemDetail: async () => {
      extraCalls++;
      return plexItem(row.ratingKey, row.partId, TO);
    },
    now: () => NOW,
  });
  assert.equal(extraCalls, 0, 'confirmed items are permanently done');
  assert.ok(calls >= 1);
});
