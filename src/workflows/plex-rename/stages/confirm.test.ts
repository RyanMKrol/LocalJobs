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

test('confirm: vanished ratingKey with NOTHING at the target path — pending inside grace, fails loud past it', async () => {
  const inGrace = applyRow();
  await runConfirm(fakeCtx(), {
    readApplyRows: () => [{ itemKey: inGrace.itemKey, detail: inGrace.detail }],
    readDiscoverRows: () => [], // no live item anywhere at the target path
    fetchItemDetail: async () => undefined,
    graceDays: 14,
    now: () => NOW,
  }); // must not throw — a rescan may still land
  const pending = confirmOf(inGrace.itemKey);
  assert.equal(pending.status, 'skipped');
  assert.equal(pending.detail.reason, 'pending-rescan');

  const stale = applyRow({ appliedAt: '2026-07-01T00:00:00.000Z' }); // 39 days before NOW
  await assert.rejects(
    runConfirm(fakeCtx(), {
      readApplyRows: () => [{ itemKey: stale.itemKey, detail: stale.detail }],
      readDiscoverRows: () => [],
      fetchItemDetail: async () => undefined,
      graceDays: 14,
      now: () => NOW,
    }),
    /failed confirmation/,
  );
  const failed = confirmOf(stale.itemKey);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.detail.reason, 'ratingkey-gone');
});

// ── Consolidation re-association (2026-08): merging a show Plex held as TWO split
// entries retires the duplicate entry and its episode items, so the original
// ratingKey legitimately 404s while the file stays correctly matched. ──

/** A discover snapshot row placing `ratingKey` at `file` with the given movie tmdb id. */
function discoverRow(ratingKey: string, file: string, tmdbId: number) {
  return {
    itemKey: `${ratingKey}::part99`,
    detail: {
      name: 'A Movie',
      kind: 'movie' as const,
      file,
      partId: 99,
      mediaCount: 1,
      partCount: 1,
      partIndex: 0,
      rootPath: '/volume1/Share/Movies',
      movie: { ratingKey, title: 'A Movie', year: 2016, tmdbId },
    },
  };
}

test('confirm: vanished ratingKey but a NEW item owns the target path with matching ids → confirmed as re-associated', async () => {
  const row = applyRow();
  await runConfirm(fakeCtx(), {
    readApplyRows: () => [{ itemKey: row.itemKey, detail: row.detail }],
    readDiscoverRows: () => [discoverRow('newRk', TO, 1)], // TO embeds {tmdb-1}
    fetchItemDetail: async () => undefined,
    now: () => NOW,
  }); // must NOT throw
  const c = confirmOf(row.itemKey);
  assert.equal(c.status, 'success');
  assert.equal(c.detail.confirmed, true);
  assert.equal(c.detail.reason, 'reassociated');
  assert.equal(c.detail.confirmedRatingKey, 'newRk');
  assert.equal(c.detail.confirmedPath, TO);
});

test('confirm: a Plex 404 error (not just a null item) also resolves via re-association', async () => {
  const row = applyRow();
  await runConfirm(fakeCtx(), {
    readApplyRows: () => [{ itemKey: row.itemKey, detail: row.detail }],
    readDiscoverRows: () => [discoverRow('newRk2', TO, 1)],
    fetchItemDetail: async () => {
      throw new Error('Plex HTTP 404 for /library/metadata/rk');
    },
    now: () => NOW,
  });
  assert.equal(confirmOf(row.itemKey).detail.reason, 'reassociated');
});

test('confirm: an item at the target path whose ids DO NOT match is never accepted as proof', async () => {
  const stale = applyRow({ appliedAt: '2026-07-01T00:00:00.000Z' }); // past grace
  await assert.rejects(
    runConfirm(fakeCtx(), {
      readApplyRows: () => [{ itemKey: stale.itemKey, detail: stale.detail }],
      readDiscoverRows: () => [discoverRow('otherRk', TO, 999)], // wrong tmdb id
      fetchItemDetail: async () => undefined,
      graceDays: 14,
      now: () => NOW,
    }),
    /failed confirmation/,
  );
  assert.equal(confirmOf(stale.itemKey).detail.reason, 'ratingkey-gone');
});

test('confirm: old ratingKey survives but points elsewhere — re-association still confirms', async () => {
  const row = applyRow();
  await runConfirm(fakeCtx(), {
    readApplyRows: () => [{ itemKey: row.itemKey, detail: row.detail }],
    readDiscoverRows: () => [discoverRow('mergedRk', TO, 1)],
    fetchItemDetail: async () => plexItem(row.ratingKey, row.partId, OLD), // still the old path
    now: () => NOW,
  });
  const c = confirmOf(row.itemKey);
  assert.equal(c.status, 'success');
  assert.equal(c.detail.confirmedRatingKey, 'mergedRk');
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

// ── Artwork continuity (2026-08) ──────────────────────────────────────────────
// Plex reverts a RECREATED entry to the agent's default poster, silently
// discarding one the owner uploaded. confirm restores what was showing before.

const OLD_UPLOAD = '/library/metadata/rk1/file?url=upload%3A%2F%2Fposters%2Fabc123';
const NEW_UPLOAD = '/library/metadata/newRk/file?url=upload%3A%2F%2Fposters%2Fabc123';
const UP_ID2 = 'upload://posters/abc123';
const AGENT_ID2 = 'metadata://posters/agent_default';
const AGENT_POSTER = '/library/metadata/newRk/file?url=metadata%3A%2F%2Fposters%2Fagent_default';

test('confirm: restores the exact artwork the owner had, on whichever entry now owns the file', async () => {
  const row = applyRow({ artwork: { poster: 'upload:abc123' } });
  const set: { ratingKey: string; kind: string; key: string }[] = [];
  await runConfirm(fakeCtx(), {
    readApplyRows: () => [{ itemKey: row.itemKey, detail: row.detail }],
    readDiscoverRows: () => [discoverRow('newRk', TO, 1)],
    fetchItemDetail: async () => undefined, // entry was recreated
    fetchArtwork: async (_rk, kind) =>
      kind === 'poster'
        ? [
            { key: AGENT_POSTER, ratingKey: AGENT_ID2, selected: true }, // Plex reverted to the default
            { key: NEW_UPLOAD, ratingKey: UP_ID2, selected: false }, // the owner's image, still there
          ]
        : [],
    setArtwork: async (ratingKey, kind, key) => {
      set.push({ ratingKey, kind, key });
    },
    now: () => NOW,
  });
  assert.equal(confirmOf(row.itemKey).status, 'success');
  // Selected by the PHOTO's ratingKey — passing the `key` URL returns 200 and does nothing.
  assert.deepEqual(set, [{ ratingKey: 'newRk', kind: 'poster', key: UP_ID2 }]);
});

test('confirm: leaves artwork alone when it is already what was recorded, and never fails a confirm over artwork', async () => {
  const intact = applyRow({ artwork: { poster: 'upload:abc123' } });
  const set: string[] = [];
  await runConfirm(fakeCtx(), {
    readApplyRows: () => [{ itemKey: intact.itemKey, detail: intact.detail }],
    fetchItemDetail: async () => plexItem(intact.ratingKey, intact.partId, TO),
    fetchArtwork: async () => [{ key: OLD_UPLOAD, ratingKey: UP_ID2, selected: true }],
    setArtwork: async (_rk, _k, key) => {
      set.push(key);
    },
    now: () => NOW,
  });
  assert.equal(set.length, 0, 'idempotent — nothing to restore');

  // An artwork failure must never take down a confirmation.
  const broken = applyRow({ artwork: { poster: 'upload:abc123' } });
  await runConfirm(fakeCtx(), {
    readApplyRows: () => [{ itemKey: broken.itemKey, detail: broken.detail }],
    fetchItemDetail: async () => plexItem(broken.ratingKey, broken.partId, TO),
    fetchArtwork: async () => {
      throw new Error('Plex artwork endpoint down');
    },
    now: () => NOW,
  });
  assert.equal(confirmOf(broken.itemKey).status, 'success', 'artwork is cosmetic; confirmation is not');
});

// ── Season/show artwork continuity (2026-08-19) ───────────────────────────────
// The moved item is an EPISODE, and episodes carry no uploads: the artwork an
// owner curates lives on the season and show, which Plex rebuilds when their
// folders change. Capturing only the episode protected nothing on TV, which cost
// 478 hand-picked season posters.

const SEASON_UP = 'upload://posters/seasons/2/aabbcc';
const SHOW_UP = 'upload://posters/ddeeff';

test('confirm: restores the season and show posters an episode rename disturbed', async () => {
  const row = applyRow({
    artwork: { season: { index: 2, poster: 'upload:seasons/2/aabbcc' }, show: { poster: 'upload:ddeeff' } },
  });
  const set: { rk: string; key: string }[] = [];
  await runConfirm(fakeCtx(), {
    readApplyRows: () => [{ itemKey: row.itemKey, detail: row.detail }],
    // The episode confirms at its own key, and reports its CURRENT season/show,
    // whose keys differ from before because Plex rebuilt them.
    fetchItemDetail: async () => ({
      ...plexItem(row.ratingKey, row.partId, TO),
      parentRatingKey: 'newSeasonRk',
      grandparentRatingKey: 'newShowRk',
    }),
    fetchArtwork: async (rk) =>
      rk === 'newSeasonRk'
        ? [{ key: '/library/metadata/newSeasonRk/file?url=metadata%3A%2F%2Fposters%2Fagent', ratingKey: 'metadata://posters/agent', selected: true },
           { key: '/library/metadata/newSeasonRk/file?url=upload%3A%2F%2Fposters%2Fseasons%2F2%2Faabbcc', ratingKey: SEASON_UP, selected: false }]
        : rk === 'newShowRk'
          ? [{ key: '/library/metadata/newShowRk/file?url=metadata%3A%2F%2Fposters%2Fagent', ratingKey: 'metadata://posters/agent', selected: true },
             { key: '/library/metadata/newShowRk/file?url=upload%3A%2F%2Fposters%2Fddeeff', ratingKey: SHOW_UP, selected: false }]
          : [],
    setArtwork: async (rk, _kind, key) => {
      set.push({ rk, key });
    },
    now: () => NOW,
  });
  assert.equal(confirmOf(row.itemKey).status, 'success');
  assert.deepEqual(set, [
    { rk: 'newSeasonRk', key: SEASON_UP },
    { rk: 'newShowRk', key: SHOW_UP },
  ], 'both parents repaired, at their NEW keys');
});

test('confirm: repairs a shared season only once per run, however many episodes moved', async () => {
  const rows = [1, 2, 3].map(() =>
    applyRow({ artwork: { season: { index: 2, poster: 'upload:seasons/2/aabbcc' } } }),
  );
  let seasonWrites = 0;
  await runConfirm(fakeCtx(), {
    readApplyRows: () => rows.map((r) => ({ itemKey: r.itemKey, detail: r.detail })),
    fetchItemDetail: async (rk) => ({ ...plexItem(String(rk), 1, TO), parentRatingKey: 'sharedSeason' }),
    fetchArtwork: async (rk) =>
      rk === 'sharedSeason'
        ? [{ key: '/library/metadata/sharedSeason/file?url=upload%3A%2F%2Fposters%2Fseasons%2F2%2Faabbcc', ratingKey: SEASON_UP, selected: false }]
        : [],
    setArtwork: async (rk) => {
      if (rk === 'sharedSeason') seasonWrites++;
    },
    now: () => NOW,
  });
  assert.equal(seasonWrites, 1, 'three episodes of one season cost one season write');
});
