// Pure-function coverage for the Inputs & Outputs panel helpers. The panel no
// longer infers anything from raw ledger detail (the server sends explicit
// display rows), so what is left to test here is small: paging de-duplication,
// the empty-state wording, and the artifact card's facts line.
//
// Self-running (mirrors the src/*.test.ts convention): run directly with
//   npx tsx --test dashboard/app/components/StageIoLists.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactFacts, dedupeStageIoItems, formatBytes, inputsEmptyText } from './StageIoLists.js';

// dashboard/ has no "type": "module" in its package.json, so top-level await
// resolves to esbuild's cjs output (unsupported) under `tsx --test` — wrap in
// an async main() instead, mirroring dashboard/scripts/nav-check.test.ts.
async function main() {
  await test('dedupeStageIoItems: a poll refresh overlapping an already-loaded page keeps one row per ledger item', () => {
    const row = (jobName: string, itemKey: string, title: string) => ({ id: `${jobName}:${itemKey}`, jobName, itemKey, title });
    const out = dedupeStageIoItems([row('a', '1', 'first'), row('a', '2', 'x'), row('a', '1', 'again'), row('b', '1', 'other job')]);
    assert.deepEqual(out.map((r) => r.title), ['first', 'x', 'other job']);
  });

  await test('inputsEmptyText: only a stage with no predecessors is called the root stage (T607)', () => {
    assert.equal(inputsEmptyText([]), 'No inputs — this is the root stage.');
    assert.equal(inputsEmptyText(['upstream']), 'No inputs recorded this run.');
  });

  await test('formatBytes: human sizes', () => {
    assert.equal(formatBytes(null), '');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(80 * 1024 * 1024), '80 MB');
  });

  await test('artifactFacts: item count and size; an inline value has no size worth showing', () => {
    assert.deepEqual(artifactFacts({ itemCount: 650, bytes: 1536, storage: 'json' }), ['650 items', '1.5 KB']);
    assert.deepEqual(artifactFacts({ itemCount: 1, bytes: 10, storage: 'json' }), ['1 item', '10 B']);
    assert.deepEqual(artifactFacts({ itemCount: null, bytes: 24, storage: 'inline' }), []);
  });
}

main();
