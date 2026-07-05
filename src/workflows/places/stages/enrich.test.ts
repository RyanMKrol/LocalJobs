// enrich.test.ts — T421: places-enrich must throw at run end when this run's own
// tally shows any genuine per-item failure, so the run is recorded 'failed' and
// downstream stages don't spawn on incomplete data. Hermetic: global.fetch is
// monkey-patched (enrich.ts calls the bare global `fetch`, not an injected client).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JobContext } from '../../../core/types.js';
import { registerService } from '../../../core/services.js';
import { enrichConfig, placesConfig } from '../config.js';
import type { ResolvedFile } from '../types.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

function resolvedFile(entries: Array<{ cid: string; placeId: string }>): ResolvedFile {
  const resolved: ResolvedFile['resolved'] = {};
  for (const e of entries) {
    resolved[e.cid] = {
      cid: e.cid, name: `Place ${e.cid}`, status: 'success', placeId: e.placeId,
      lat: 1, lng: 2, featureId: null, kgMid: null, resolvedAt: new Date(0).toISOString(), attempts: 1,
    };
  }
  return { generatedAt: new Date(0).toISOString(), resolved };
}

function withTmpPaths<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'places-enrich-'));
  const origResolvedOut = placesConfig.resolvedOut;
  const origEnrichedOut = placesConfig.enrichedOut;
  const origApiKey = enrichConfig.apiKey;
  const origDryRun = enrichConfig.dryRun;
  (placesConfig as { resolvedOut: string }).resolvedOut = join(dir, 'resolved.json');
  (placesConfig as { enrichedOut: string }).enrichedOut = join(dir, 'enriched.json');
  (enrichConfig as { apiKey: string }).apiKey = 'test-key';
  (enrichConfig as { dryRun: boolean }).dryRun = false;
  return fn().finally(() => {
    (placesConfig as { resolvedOut: string }).resolvedOut = origResolvedOut;
    (placesConfig as { enrichedOut: string }).enrichedOut = origEnrichedOut;
    (enrichConfig as { apiKey: string }).apiKey = origApiKey;
    (enrichConfig as { dryRun: boolean }).dryRun = origDryRun;
  });
}

function installFakeFetch(byPlaceId: Record<string, { ok: boolean; status?: number; body?: unknown }>) {
  const original = global.fetch;
  global.fetch = (async (url: string) => {
    const placeId = String(url).split('/').pop()!;
    const spec = byPlaceId[placeId];
    if (spec.ok) {
      return { ok: true, json: async () => spec.body ?? {} } as Response;
    }
    return {
      ok: false, status: spec.status ?? 500,
      text: async () => JSON.stringify({ error: { status: 'INTERNAL' } }),
    } as unknown as Response;
  }) as typeof fetch;
  return () => { global.fetch = original; };
}

await test('runEnrich throws naming the failed count when some places fail to enrich this run', async () => {
  await withTmpPaths(async () => {
    const { runEnrich } = await import('./enrich.js');
    writeFileSync(placesConfig.resolvedOut, JSON.stringify(resolvedFile([
      { cid: 't421-e-ok', placeId: 'place-ok-1' },
      { cid: 't421-e-bad', placeId: 'place-bad-1' },
    ])));
    const restore = installFakeFetch({
      'place-ok-1': { ok: true, body: { displayName: { text: 'Ok Place' } } },
      'place-bad-1': { ok: false, status: 500 },
    });
    try {
      await assert.rejects(
        () => runEnrich(fakeCtx()),
        (err: Error) => {
          assert.match(err.message, /1\/2 place\(s\) failed to enrich this run/);
          return true;
        },
      );
    } finally {
      restore();
    }
  });
});

await test('runEnrich resolves normally when every place enriches successfully', async () => {
  await withTmpPaths(async () => {
    const { runEnrich } = await import('./enrich.js');
    writeFileSync(placesConfig.resolvedOut, JSON.stringify(resolvedFile([
      { cid: 't421-e-ok-1', placeId: 'place-ok-2' },
      { cid: 't421-e-ok-2', placeId: 'place-ok-3' },
    ])));
    const restore = installFakeFetch({
      'place-ok-2': { ok: true, body: { displayName: { text: 'Ok Place 2' } } },
      'place-ok-3': { ok: true, body: { displayName: { text: 'Ok Place 3' } } },
    });
    try {
      await runEnrich(fakeCtx()); // must not throw/reject
    } finally {
      restore();
    }
  });
});

await test('runEnrich resolves normally (no throw) when nothing is left to enrich (soft no-op, not a failure)', async () => {
  await withTmpPaths(async () => {
    const { runEnrich } = await import('./enrich.js');
    writeFileSync(placesConfig.resolvedOut, JSON.stringify(resolvedFile([])));
    await runEnrich(fakeCtx()); // "nothing to do" early return — must not throw
  });
});

await test('runEnrich resolves normally (no throw) when the google-places service quota is already exhausted before any item is attempted', async () => {
  await withTmpPaths(async () => {
    // Force the pre-loop "quota already exhausted" soft-stop by registering a
    // zero-cap google-places service definition — no item is ever attempted, so
    // the failed tally stays 0 and no throw should fire.
    registerService({ name: 'google-places', dailyCap: 0 });
    const { runEnrich } = await import('./enrich.js');
    writeFileSync(placesConfig.resolvedOut, JSON.stringify(resolvedFile([
      { cid: 't421-e-quota', placeId: 'place-quota-1' },
    ])));
    await runEnrich(fakeCtx()); // must not throw/reject
  });
});
