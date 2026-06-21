// Regression guard for T012: the places pipeline runs on a DAILY cron, and each
// paid stage's daily spend cap is the monthly free allowance / 30 — so a full
// month of daily runs can never exceed the monthly cap. Runs against the scratch
// DB set by `npm test` (LOCALJOBS_DB). Self-asserting: throws on failure.
import assert from 'node:assert/strict';
import { capStatus, recordUsage } from '../../db/store.js';
import { DAILY_SPEND_DIVISOR, enrichConfig, llmConfig } from './config.js';
import pipeline from './places.pipeline.js';

// 1. The pipeline is no longer manual-only — it runs daily at 03:00.
assert.equal(pipeline.schedule, '0 3 * * *', 'places pipeline must run on a daily cron, not manual-only');

// 2. Daily caps derive from the monthly free allowance / 30 (env-overridable).
assert.equal(DAILY_SPEND_DIVISOR, 30);
assert.equal(enrichConfig.dailyCap, Math.floor(enrichConfig.monthlyCap / DAILY_SPEND_DIVISOR), 'places-enrich daily cap = monthly/30');
assert.equal(llmConfig.dailyCap, Math.floor(llmConfig.monthlyCap / DAILY_SPEND_DIVISOR), 'enrich-with-llm daily cap = monthly/30');

// The invariant that protects the monthly budget: a whole month of daily runs at
// the daily cap stays within the monthly cap (this is the regression we guard —
// the generic monthly/10 rule would let ~10 daily runs blow the month).
assert.ok(enrichConfig.dailyCap * DAILY_SPEND_DIVISOR <= enrichConfig.monthlyCap, 'a month of daily enrich runs must fit the monthly cap');
assert.ok(llmConfig.dailyCap * DAILY_SPEND_DIVISOR <= llmConfig.monthlyCap, 'a month of daily llm runs must fit the monthly cap');

// 3. The enforcement the enrich loops rely on (capStatus + recordUsage) actually
//    stops once the daily cap is hit.
const JOB = 'places-enrich-captest';
for (let i = 0; i < enrichConfig.dailyCap; i++) {
  assert.ok(capStatus(JOB, enrichConfig.dailyCap, enrichConfig.monthlyCap).allowed, `still allowed at usage ${i}`);
  recordUsage(JOB);
}
const after = capStatus(JOB, enrichConfig.dailyCap, enrichConfig.monthlyCap);
assert.equal(after.allowed, false, 'loop must stop once the daily cap is reached');
assert.match(after.reason, /daily cap reached/);

console.log('  ✓ places daily schedule + monthly/30 spend cap (loop stops at daily cap)');
