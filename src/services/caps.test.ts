// Regression guard for T012 (relocated here by T044): each PAID service seeds its
// daily cap as the monthly free allowance / 30, so a full month of daily-scheduled
// runs can NEVER exceed the monthly cap. Since the service quota is the single
// source of truth for shared spend, this invariant lives with the services. Runs
// against the scratch DB set by `npm test` (LOCALJOBS_DB). Self-asserting: throws
// on failure.
import assert from 'node:assert/strict';
import { capStatus, recordUsage } from '../db/store.js';
import { DAILY_SPEND_DIVISOR } from './lib.js';
import gemini from './gemini.service.js';
import googlePlaces from './google-places.service.js';

assert.equal(DAILY_SPEND_DIVISOR, 30);

// 1. Each paid service seeds daily = floor(monthly / 30), and a whole month of
//    daily runs at the daily cap stays within the monthly cap (the invariant we
//    guard — the generic monthly/10 rule would let ~10 daily runs blow the month).
for (const svc of [gemini, googlePlaces]) {
  assert.ok(svc.paid, `${svc.name} must be a paid service`);
  assert.ok(typeof svc.monthlyCap === 'number' && svc.monthlyCap > 0, `${svc.name} needs a monthly cap`);
  assert.equal(svc.dailyCap, Math.floor(svc.monthlyCap! / DAILY_SPEND_DIVISOR), `${svc.name} daily cap = monthly/30`);
  assert.ok(svc.dailyCap! * DAILY_SPEND_DIVISOR <= svc.monthlyCap!, `a month of daily ${svc.name} runs must fit the monthly cap`);
}

// 2. The enforcement the enrich loops rely on (capStatus + recordUsage) actually
//    stops once the daily cap is hit.
const JOB = 'paid-service-captest';
const dailyCap = gemini.dailyCap!;
const monthlyCap = gemini.monthlyCap!;
for (let i = 0; i < dailyCap; i++) {
  assert.ok(capStatus(JOB, dailyCap, monthlyCap).allowed, `still allowed at usage ${i}`);
  recordUsage(JOB);
}
const after = capStatus(JOB, dailyCap, monthlyCap);
assert.equal(after.allowed, false, 'loop must stop once the daily cap is reached');
assert.match(after.reason, /daily cap reached/);

console.log('  ✓ paid services seed dailyCap = monthly/30 (a month of daily runs fits the monthly cap; loop stops at daily cap)');
