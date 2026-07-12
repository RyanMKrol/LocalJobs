// llm-enrich.test.ts — T421: enrich-with-llm must throw at run end when this run's
// own tally shows any genuine per-item failure, so the run is recorded 'failed' and
// downstream stages don't spawn on incomplete data. Hermetic: global.fetch is
// monkey-patched — the @google/genai SDK's generateContent ultimately calls the
// bare global `fetch`, so no real network call happens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JobContext } from '../../../core/types.js';
import { registerService } from '../../../core/services.js';
import { llmConfig, placesConfig } from '../config.js';
import type { EnrichedFile, EnrichedPlace } from '../types.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

function enrichedFile(cids: string[]): EnrichedFile {
  const enriched: Record<string, EnrichedPlace> = {};
  for (const cid of cids) {
    enriched[cid] = {
      cid, placeId: `place-${cid}`, status: 'success', enrichedAt: new Date(0).toISOString(),
      attempts: 1, data: { displayName: { text: `Place ${cid}` } },
    };
  }
  return { generatedAt: new Date(0).toISOString(), enriched };
}

function withTmpPaths<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'places-llm-'));
  const origEnrichedOut = placesConfig.enrichedOut;
  const origLlmOut = placesConfig.llmOut;
  const origMarkdownDir = placesConfig.markdownDir;
  const origPlacesOut = placesConfig.placesOut;
  const origApiKey = llmConfig.apiKey;
  const origDryRun = llmConfig.dryRun;
  (placesConfig as { enrichedOut: string }).enrichedOut = join(dir, 'enriched.json');
  (placesConfig as { llmOut: string }).llmOut = join(dir, 'llm-enriched.json');
  (placesConfig as { markdownDir: string }).markdownDir = join(dir, 'markdown');
  (placesConfig as { placesOut: string }).placesOut = join(dir, 'places.json'); // absent — placesMeta stays empty
  (llmConfig as { apiKey: string }).apiKey = 'test-key';
  (llmConfig as { dryRun: boolean }).dryRun = false;
  return fn().finally(() => {
    (placesConfig as { enrichedOut: string }).enrichedOut = origEnrichedOut;
    (placesConfig as { llmOut: string }).llmOut = origLlmOut;
    (placesConfig as { markdownDir: string }).markdownDir = origMarkdownDir;
    (placesConfig as { placesOut: string }).placesOut = origPlacesOut;
    (llmConfig as { apiKey: string }).apiKey = origApiKey;
    (llmConfig as { dryRun: boolean }).dryRun = origDryRun;
  });
}

/** Fake the Gemini HTTP call: return valid JSON prose for "good" cids, and
 *  JSON-free prose (which parseResult rejects) for "bad" ones, keyed by a
 *  marker baked into the request body's prompt text. */
function installFakeGeminiFetch(goodCids: string[]) {
  const original = global.fetch;
  global.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    const isGood = goodCids.some((cid) => body.includes(`Place ${cid}`));
    const text = isGood ? JSON.stringify({ editorial: 'a real profile' }) : 'no json here, sorry';
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return () => { global.fetch = original; };
}

await test('runLlmEnrich throws naming the failed count when some places fail to LLM-enrich this run', async () => {
  await withTmpPaths(async () => {
    const { runLlmEnrich } = await import('./llm-enrich.js');
    writeFileSync(placesConfig.enrichedOut, JSON.stringify(enrichedFile(['t421-l-ok', 't421-l-bad'])));
    const restore = installFakeGeminiFetch(['t421-l-ok']);
    try {
      await assert.rejects(
        () => runLlmEnrich(fakeCtx()),
        (err: Error) => {
          assert.match(err.message, /1\/2 place\(s\) failed to LLM-enrich this run/);
          return true;
        },
      );
    } finally {
      restore();
    }
  });
});

await test('runLlmEnrich resolves normally when every place LLM-enriches successfully', async () => {
  await withTmpPaths(async () => {
    const { runLlmEnrich } = await import('./llm-enrich.js');
    writeFileSync(placesConfig.enrichedOut, JSON.stringify(enrichedFile(['t421-l-ok-1', 't421-l-ok-2'])));
    const restore = installFakeGeminiFetch(['t421-l-ok-1', 't421-l-ok-2']);
    try {
      await runLlmEnrich(fakeCtx()); // must not throw/reject
    } finally {
      restore();
    }
  });
});

await test('runLlmEnrich resolves normally (no throw) when the gemini service quota is already exhausted before any item is attempted', async () => {
  await withTmpPaths(async () => {
    // Force the pre-loop "quota already exhausted" soft-stop by registering a
    // zero-cap gemini service definition — QuotaExceededError fires on the very
    // first call, before any place is genuinely attempted; the failed tally stays
    // 0 so no throw should fire.
    registerService({ name: 'gemini', dailyCap: 0 });
    const { runLlmEnrich } = await import('./llm-enrich.js');
    writeFileSync(placesConfig.enrichedOut, JSON.stringify(enrichedFile(['t421-l-quota'])));
    await runLlmEnrich(fakeCtx()); // must not throw/reject
  });
});

await test('gemini service is configured with 22-hour cacheTtlMs (T505)', async () => {
  const { default: geminiService } = await import('../../../services/gemini.service.js');
  assert.equal(geminiService.cacheTtlMs, 79_200_000, 'gemini service must have cacheTtlMs = 79_200_000 (22 hours)');
});
