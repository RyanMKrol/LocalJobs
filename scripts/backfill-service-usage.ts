// One-time backfill: top up THIS MONTH's shared `service_usage` meter from the
// legacy per-job `job_usage` meter, after migrating spend governance off the
// per-job caps onto the shared service quota (T013).
//
// Before T013, places-enrich and enrich-with-llm metered their paid calls on
// BOTH the per-job `job_usage` table AND (since the service migration) the shared
// `service_usage` table. With the per-job caps removed, `service_usage` is now
// the single source of truth — but it under-counts the calls already made this
// month that only landed in `job_usage`. This script reconciles the gap.
//
// IDEMPOTENT: it adds only the DIFFERENCE (jobUsage − serviceUsage) per service,
// so a second run is a no-op. It NEVER touches `job_usage` and makes NO API
// calls — it only reads/writes the local SQLite meter tables.
//
// Run (against the live data/jobs.db): `npx tsx scripts/backfill-service-usage.ts`
// Point at a scratch DB with LOCALJOBS_DB=/tmp/foo.db to dry-test.
import {
  backfillServiceUsage,
  serviceCallsThisMonth,
  serviceCallsToday,
  usageThisMonth,
} from '../src/db/store.js';

// Each paid service ← the job that historically metered onto job_usage.
const MAP: Array<{ service: string; job: string }> = [
  { service: 'google-places', job: 'places-enrich' },
  { service: 'gemini', job: 'enrich-with-llm' },
];

console.log('── backfill-service-usage (this calendar month) ──\n');

let totalAdded = 0;
let failures = 0;

for (const { service, job } of MAP) {
  const jobMonth = usageThisMonth(job);
  const svcBefore = serviceCallsThisMonth(service);
  const topup = Math.max(0, jobMonth - svcBefore);

  console.log(`${service}  ←  ${job}`);
  console.log(`  job_usage (month):      ${jobMonth}`);
  console.log(`  service_usage (before): ${svcBefore}`);
  console.log(`  topping up by:          ${topup}${topup === 0 ? '  (already reconciled — no-op)' : ''}`);

  backfillServiceUsage(service, topup);
  totalAdded += topup;

  const svcAfter = serviceCallsThisMonth(service);
  const expected = Math.max(jobMonth, svcBefore);
  const ok = svcAfter === expected;
  console.log(`  service_usage (after):  ${svcAfter}  (today: ${serviceCallsToday(service)})`);
  console.log(`  reconciled:             ${ok ? '✓' : '✗ MISMATCH'} (expected ${expected})\n`);
  if (!ok) failures++;
}

console.log(`Done. Added ${totalAdded} service_usage row(s) total.`);
if (failures > 0) {
  console.error(`✗ ${failures} service(s) failed to reconcile.`);
  process.exitCode = 1;
}
