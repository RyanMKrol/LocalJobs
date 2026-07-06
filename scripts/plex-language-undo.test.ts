// Tests for the manual plex-language-undo script's revert computation — never
// touches the real Plex server (a fake `put` is injected).
import assert from 'node:assert/strict';

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

console.log('  ✓ plex-language-undo tests passed');
