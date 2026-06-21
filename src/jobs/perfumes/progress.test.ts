// Guards per-item progress for the perfumes item-loop stages (find-url, fetch,
// parse, build). Each stage now reports progress AS IT WORKS via the shared
// `reportItemProgress` helper, so a long stage advances the run % per item
// instead of jumping 0→100 only at the end. This drives that helper directly —
// no config / DB / live calls — and asserts the percentages it emits.
import assert from 'node:assert/strict';
import { reportItemProgress } from './lib.js';

interface ProgressCall { pct: number; msg: string }

/** A fake JobContext that just captures every progress() call. */
function fakeCtx(): { progress: (pct: number, msg?: string) => void; calls: ProgressCall[] } {
  const calls: ProgressCall[] = [];
  return { calls, progress: (pct, msg = '') => calls.push({ pct, msg }) };
}

// ── Progress advances monotonically once per item and lands exactly on 100. ──
{
  const ctx = fakeCtx();
  const total = 4;
  for (let i = 0; i < total; i++) reportItemProgress(ctx, i + 1, total);
  assert.equal(ctx.calls.length, total, 'one progress update per processed item');
  assert.deepEqual(
    ctx.calls.map((c) => c.pct),
    [25, 50, 75, 100],
    'percent advances evenly over the item count and ends exactly at 100',
  );
  // Strictly increasing — the run % only ever moves forward as items finish.
  for (let i = 1; i < ctx.calls.length; i++) {
    assert.ok(ctx.calls[i].pct > ctx.calls[i - 1].pct, 'progress is strictly increasing');
  }
}

// ── The status carries the i/N counter (and any suffix), so logs show "1/41 …". ──
{
  const ctx = fakeCtx();
  reportItemProgress(ctx, 1, 41, '1 ok, 0 failed');
  assert.equal(ctx.calls[0].msg, '1/41 · 1 ok, 0 failed', 'status is "done/total · suffix"');
  const ctx2 = fakeCtx();
  reportItemProgress(ctx2, 7, 7);
  assert.equal(ctx2.calls[0].msg, '7/7', 'no suffix → just done/total');
}

// ── An empty run (total 0) reports 100, never NaN/divide-by-zero. ──
{
  const ctx = fakeCtx();
  reportItemProgress(ctx, 0, 0);
  assert.equal(ctx.calls[0].pct, 100, 'total 0 → 100% (nothing to do), not NaN');
  assert.ok(Number.isFinite(ctx.calls[0].pct), 'pct is always a finite number');
}

console.log('  ✓ perfumes per-item progress advances during the run (reportItemProgress)');
