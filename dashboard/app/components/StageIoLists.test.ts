// Pure-function coverage for the detail-hints extraction helper (T457) — no
// browser/React rendering needed, this only exercises `detailHints`/
// `humanizeDetailKey`.
//
// Self-running (mirrors the src/*.test.ts convention): run directly with
//   npx tsx --test dashboard/app/components/StageIoLists.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { detailHints, humanizeDetailKey, inputsEmptyText } from './StageIoLists.js';

// dashboard/ has no "type": "module" in its package.json, so top-level await
// resolves to esbuild's cjs output (unsupported) under `tsx --test` — wrap in
// an async main() instead, mirroring dashboard/scripts/nav-check.test.ts.
async function main() {
  await test('detailHints: a detail with only name yields no hints', () => {
    assert.deepEqual(detailHints({ name: 'Some Place' }), []);
  });

  await test('detailHints: a detail with null/undefined yields no hints', () => {
    assert.deepEqual(detailHints(null), []);
    assert.deepEqual(detailHints(undefined), []);
  });

  await test('detailHints: extra scalar fields humanize into labeled hints', () => {
    const hints = detailHints({
      name: 'Some Place',
      placeId: 'ChIJabc123',
      rating: 4.5,
      resolvedCount: 3,
      isOpen: true,
    });
    assert.deepEqual(hints, [
      { label: 'Place Id', value: 'ChIJabc123' },
      { label: 'Rating', value: '4.5' },
      { label: 'Resolved Count', value: '3' },
      { label: 'Is Open', value: 'true' },
    ]);
  });

  await test('detailHints: snake_case keys humanize too', () => {
    const hints = detailHints({ resolved_count: 7, total_positions: 12 });
    assert.deepEqual(hints, [
      { label: 'Resolved Count', value: '7' },
      { label: 'Total Positions', value: '12' },
    ]);
  });

  await test('detailHints: long string values are truncated with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const [hint] = detailHints({ description: long });
    assert.equal(hint.label, 'Description');
    assert.ok(hint.value.length <= 80);
    assert.ok(hint.value.endsWith('…'));
  });

  await test('detailHints: nested object/array fields are silently skipped, not stringified', () => {
    const hints = detailHints({
      name: 'Some Place',
      address: '221B Baker St',
      metadata: { foo: 'bar' },
      tags: ['a', 'b'],
    });
    assert.deepEqual(hints, [{ label: 'Address', value: '221B Baker St' }]);
  });

  await test('detailHints: caps the number of hints shown', () => {
    const hints = detailHints({
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      f: 6,
    });
    assert.equal(hints.length, 4);
  });

  await test('detailHints: excludes bookkeeping/artifact-plumbing keys', () => {
    const hints = detailHints({
      name: 'Some Place',
      markdown: '/path/to/out.md',
      path: '/path/to/out.json',
      format: 'json',
      attempts: 2,
      rating: 4.2,
    });
    assert.deepEqual(hints, [{ label: 'Rating', value: '4.2' }]);
  });

  await test('humanizeDetailKey: camelCase and snake_case both become Title Case', () => {
    assert.equal(humanizeDetailKey('placeId'), 'Place Id');
    assert.equal(humanizeDetailKey('resolved_count'), 'Resolved Count');
    assert.equal(humanizeDetailKey('totalPositions'), 'Total Positions');
  });

  await test('inputsEmptyText: no predecessors at all -> the root-stage message (T607)', () => {
    assert.equal(inputsEmptyText([]), 'No inputs — this is the root stage.');
  });

  await test('inputsEmptyText: has predecessor(s) but they recorded no rows this run -> NOT the root-stage message (T607)', () => {
    assert.equal(inputsEmptyText(['franchise-gaps']), 'No inputs recorded this run.');
    assert.equal(inputsEmptyText(['movie-snapshot', 'stock-sector-lookup']), 'No inputs recorded this run.');
  });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
