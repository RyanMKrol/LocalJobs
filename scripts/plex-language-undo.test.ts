// Tests for the manual plex-language-undo script's revert computation — never
// touches the real Plex server (a fake `put` is injected).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { callService } from '../src/core/services.js';
import type { AppliedLog } from '../src/workflows/plex-language-fix/types.js';
import { runUndo } from './plex-language-undo.js';

const log: AppliedLog = {
  generatedAt: new Date(0).toISOString(),
  butlerBackup: { ok: true },
  entries: [
    {
      partId: 101,
      itemTitle: 'Amelie',
      beforeAudio: { streamId: 10, label: 'English' },
      afterAudio: { streamId: 11, label: 'French (Original)' },
      beforeSubtitle: null,
      afterSubtitle: { streamId: 20, label: 'English' },
      outcome: 'applied',
      at: new Date(0).toISOString(),
    },
    {
      partId: 202,
      itemTitle: 'Failed Movie',
      beforeAudio: { streamId: 30, label: 'English' },
      afterAudio: { streamId: 31, label: 'Spanish' },
      beforeSubtitle: null,
      afterSubtitle: null,
      outcome: 'failed',
      error: 'Plex HTTP 500',
      at: new Date(0).toISOString(),
    },
  ],
};

// (a) dry run computes the revert but calls no PUT.
{
  let putCalled = false;
  const results = await runUndo(log, {
    apply: false,
    put: async () => {
      putCalled = true;
    },
    log: () => {},
  });
  assert.equal(putCalled, false, 'dry run must never call put');
  assert.equal(results.length, 1, 'only the single applied entry is revertible — the failed one is skipped');
  assert.equal(results[0].outcome, 'dry-run');
  assert.equal(results[0].partId, 101);
  console.log('  ✓ dry run computes the revert without calling put, and skips non-applied entries');
}

// (b) --apply swaps before/after — the PUT reverts to the ORIGINAL (beforeAudio) selection.
{
  const puts: Array<{ partId: number; audio: number; subtitle: number | null }> = [];
  const results = await runUndo(log, {
    apply: true,
    put: async (partId, audio, subtitle) => {
      puts.push({ partId, audio, subtitle: subtitle ?? null });
    },
    log: () => {},
  });
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0], { partId: 101, audio: 10, subtitle: null });
  assert.equal(results[0].outcome, 'reverted');
  console.log('  ✓ --apply reverts to the recorded before-state (before/after swapped correctly)');
}

// (c) a put failure during --apply is recorded 'failed' with the error captured.
{
  const results = await runUndo(log, {
    apply: true,
    put: async () => {
      throw new Error('Plex HTTP 503');
    },
    log: () => {},
  });
  assert.equal(results[0].outcome, 'failed');
  assert.equal(results[0].error, 'Plex HTTP 503');
  console.log('  ✓ a put failure during --apply is recorded failed with the error captured');
}

// (d) source wiring: the real (non-injected) --apply call site routes the revert
// through callService('plex', ...) — mirroring plex-language-fix/stages/apply.ts's
// established metering pattern — while the injected-`put`-for-tests branch calls
// `put` directly, never through callService, so every test above touches zero
// real network / service_usage DB state.
{
  const src = readFileSync(new URL('./plex-language-undo.ts', import.meta.url), 'utf8');
  const branch = src.match(/if \(opts\.put\) \{([\s\S]*?)\} else \{([\s\S]*?)\}/);
  assert.ok(branch, 'runUndo must branch on opts.put around the real Plex revert call');
  assert.doesNotMatch(
    branch[1],
    /callService/,
    'the injected-put (test) branch must call put directly, bypassing callService',
  );
  assert.match(
    branch[2],
    /callService\(\s*'plex'/,
    "the real (non-injected) path must route the revert through callService('plex', ...)",
  );
  console.log('  ✓ the real Plex revert call is routed through callService(\'plex\', ...); the injected test put bypasses it');
}

// (e) callService('plex', ...) is a transparent wrapper when the plex service is
// unregistered in tests (mirrors apply.test.ts) — confirms wrapping the real call
// in callService doesn't change its behavior or return value.
{
  let called = false;
  const result = await callService('plex', async () => {
    called = true;
    return 'ok';
  });
  assert.equal(called, true, 'callService passes through when plex service is unregistered in tests');
  assert.equal(result, 'ok', 'result is returned unchanged');
  console.log('  ✓ callService(\'plex\', ...) pass-through wrapper works (unregistered service in test)');
}

console.log('  ✓ plex-language-undo tests passed');
