// T420: an item-loop stage must fail its own run when this run's own tally shows
// failed > 0 — the wrapper `.job.ts` files are the one place that call-and-discard
// the stage's StageResult, so the throw decision belongs there. Exercises each
// stage's exported `assertNoFailures` against synthetic StageResult fixtures — no
// live network/Claude/browser calls needed, since the decision is pure.
import assert from 'node:assert/strict';
import { assertNoFailures as findUrlAssert } from './find-url.job.js';
import { assertNoFailures as fetchAssert } from './fetch.job.js';
import { assertNoFailures as parseAssert } from './parse.job.js';
import { assertNoFailures as buildAssert } from './build.job.js';
import type { StageResult } from '../types.js';

const CASES: Array<{ name: string; assertNoFailures: (r: StageResult) => void; noun: string }> = [
  { name: 'perfumes-find-url', assertNoFailures: findUrlAssert, noun: 'perfume(s) failed to find a Fragrantica URL' },
  { name: 'perfumes-fetch', assertNoFailures: fetchAssert, noun: 'page(s) failed to fetch' },
  { name: 'perfumes-parse', assertNoFailures: parseAssert, noun: 'page(s) failed to parse' },
  { name: 'perfumes-build', assertNoFailures: buildAssert, noun: 'profile(s) failed to build' },
];

for (const { name, assertNoFailures, noun } of CASES) {
  // ── failed > 0 → throws, message names the tally + stage's noun. ──
  {
    const result: StageResult = { ok: 2, failed: 1, pending: 0, rateLimited: false };
    assert.throws(() => assertNoFailures(result), new RegExp(`1/3 ${noun.replace(/[()]/g, '\\$&')}`), `${name}: failed>0 must throw`);
  }

  // ── all failed, zero ok → still throws. ──
  {
    const result: StageResult = { ok: 0, failed: 1, pending: 0, rateLimited: false };
    assert.throws(() => assertNoFailures(result), /1\/1/, `${name}: all-failed tally must throw`);
  }

  // ── failed === 0 → does not throw, even with pending work left. ──
  {
    const result: StageResult = { ok: 3, failed: 0, pending: 5, rateLimited: false };
    assert.doesNotThrow(() => assertNoFailures(result), `${name}: no failures must not throw`);
  }

  // ── rateLimited:true with failed:0 → soft defer, must NOT throw. ──
  {
    const result: StageResult = { ok: 1, failed: 0, pending: 4, rateLimited: true };
    assert.doesNotThrow(() => assertNoFailures(result), `${name}: rate-limited soft-stop with no failures must not throw`);
  }

  // ── rateLimited:true WITH failed>0 → still throws (a rate limit hit after real failures). ──
  {
    const result: StageResult = { ok: 0, failed: 2, pending: 4, rateLimited: true };
    assert.throws(() => assertNoFailures(result), /2\/2/, `${name}: rate-limited run with genuine failures must still throw`);
  }
}

console.log('  ✓ perfumes stage .job.ts wrappers throw iff this run left failed > 0 (find-url, fetch, parse, build)');
