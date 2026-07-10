// resolve.test.ts — T421: cid-to-place-id-resolver must throw at run end when this
// run's own tally shows any genuine per-item failure (mismatch/no_place_id/error),
// so the run is recorded 'failed' and downstream stages don't spawn on bad data.
// Hermetic: chromium.launch is monkey-patched (a live import from 'playwright' — its
// named export is a shared object, so mutating chromium.launch here is visible to
// resolve.ts's own `import { chromium } from 'playwright'`, no real browser launched).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

import type { JobContext } from '../../../core/types.js';
import { placesConfig, resolveConfig } from '../config.js';
import type { IngestOutput } from '../types.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

function ingestFile(cids: string[]): IngestOutput {
  return {
    generatedAt: new Date(0).toISOString(),
    source: 'google-takeout',
    places: cids.map((cid) => ({
      cid, cidHex: null, featureId: null, name: `Place ${cid}`, url: '', cidUrl: null, lists: ['Saved'],
    })) as IngestOutput['places'],
  };
}

/** A fake page whose network-response callback can be fed a fabricated ChIJ place_id. */
function fakePage(placeId: string | null) {
  let responseCb: ((res: { text(): Promise<string> }) => unknown) | undefined;
  return {
    on(event: string, cb: typeof responseCb) { if (event === 'response') responseCb = cb; },
    goto: async () => {
      if (placeId && responseCb) await responseCb({ text: async () => `xhr-body ${placeId} tail` });
    },
    waitForFunction: async () => {},
    waitForTimeout: async () => {},
    url: () => 'https://www.google.com/maps/place/Test/@1,2,3z',
    close: async () => {},
  };
}

/** Install a fake chromium.launch that hands out one fake page per CID in order. */
function installFakeBrowser(placeIdsInOrder: Array<string | null>) {
  const original = chromium.launch;
  let idx = 0;
  (chromium as unknown as { launch: typeof chromium.launch }).launch = (async () => ({
    newContext: async () => ({
      addCookies: async () => {},
      newPage: async () => fakePage(placeIdsInOrder[idx++]),
    }),
    close: async () => {},
  })) as unknown as typeof chromium.launch;
  return () => { (chromium as unknown as { launch: typeof chromium.launch }).launch = original; };
}

function withTmpPaths<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'places-resolve-'));
  const origPlacesOut = placesConfig.placesOut;
  const origResolvedOut = placesConfig.resolvedOut;
  const origDailyCap = resolveConfig.dailyCap;
  const origMonthlyCap = resolveConfig.monthlyCap;
  (placesConfig as { placesOut: string }).placesOut = join(dir, 'places.json');
  (placesConfig as { resolvedOut: string }).resolvedOut = join(dir, 'resolved.json');
  return fn().finally(() => {
    (placesConfig as { placesOut: string }).placesOut = origPlacesOut;
    (placesConfig as { resolvedOut: string }).resolvedOut = origResolvedOut;
    resolveConfig.dailyCap = origDailyCap;
    resolveConfig.monthlyCap = origMonthlyCap;
  });
}

await test('resolveInputKeys derives CIDs live from data/raw CSVs, not from data/out/places.json (T484)', async () => {
  await withTmpPaths(async () => {
    const { resolveInputKeys } = await import('./resolve.js');
    const savedDir = mkdtempSync(join(tmpdir(), 'places-saved-'));
    const origSavedDir = placesConfig.savedDir;
    (placesConfig as { savedDir: string }).savedDir = savedDir;
    try {
      writeFileSync(
        join(savedDir, 'Favourites.csv'),
        'Title,Note,URL,Tags,Comment\n' +
          'Test Place,,https://www.google.com/maps/place/Test+Place/data=!4m6!3m5!1s0x1234:0xabcdef!8m2!3d1!4d2,,\n',
      );
      // Simulate a "Clear output data" reset: places.json does NOT exist (never
      // written by withTmpPaths, and not created by this test either).
      const keys = await resolveInputKeys();
      assert.deepEqual(keys, ['11259375']); // decimal of 0xabcdef
    } finally {
      (placesConfig as { savedDir: string }).savedDir = origSavedDir;
    }
  });
});

await test('resolveInputKeys returns [] when data/raw/Saved has no CSVs', async () => {
  await withTmpPaths(async () => {
    const { resolveInputKeys } = await import('./resolve.js');
    const savedDir = mkdtempSync(join(tmpdir(), 'places-saved-empty-'));
    const origSavedDir = placesConfig.savedDir;
    (placesConfig as { savedDir: string }).savedDir = savedDir;
    try {
      const keys = await resolveInputKeys();
      assert.deepEqual(keys, []);
    } finally {
      (placesConfig as { savedDir: string }).savedDir = origSavedDir;
    }
  });
});

await test('runResolve throws naming the failed count when some places fail to resolve this run', async () => {
  await withTmpPaths(async () => {
    const { runResolve } = await import('./resolve.js');
    writeFileSync(placesConfig.placesOut, JSON.stringify(ingestFile(['t421-r-ok', 't421-r-bad'])));
    const restore = installFakeBrowser([`ChIJ${'A'.repeat(21)}`, null]);
    try {
      await assert.rejects(
        () => runResolve(fakeCtx()),
        (err: Error) => {
          assert.match(err.message, /1\/2 place\(s\) failed to resolve this run/);
          return true;
        },
      );
    } finally {
      restore();
    }
  });
});

await test('runResolve resolves normally when every place resolves successfully', async () => {
  await withTmpPaths(async () => {
    const { runResolve } = await import('./resolve.js');
    writeFileSync(placesConfig.placesOut, JSON.stringify(ingestFile(['t421-r-ok-1', 't421-r-ok-2'])));
    const restore = installFakeBrowser([`ChIJ${'A'.repeat(21)}`, `ChIJ${'B'.repeat(21)}`]);
    try {
      const file = await runResolve(fakeCtx());
      assert.equal(file.resolved['t421-r-ok-1'].status, 'success');
      assert.equal(file.resolved['t421-r-ok-2'].status, 'success');
    } finally {
      restore();
    }
  });
});

await test('runResolve resolves normally (no throw) on a soft usage-cap stop with zero genuine failures', async () => {
  await withTmpPaths(async () => {
    const { runResolve } = await import('./resolve.js');
    writeFileSync(placesConfig.placesOut, JSON.stringify(ingestFile(['t421-r-cap'])));
    // Force the "usage cap already reached before any item attempted" soft-stop —
    // no item is ever processed, so counts stays all-zero and no throw should fire.
    resolveConfig.dailyCap = 0;
    const restore = installFakeBrowser([]);
    try {
      await runResolve(fakeCtx()); // must not throw/reject
    } finally {
      restore();
    }
  });
});
