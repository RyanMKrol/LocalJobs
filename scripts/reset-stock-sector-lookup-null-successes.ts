// One-time recovery: clear `stock-sector-lookup` ledger rows that a ticker-format
// bug wrongly recorded as `success` (T352).
//
// Before T352, `stock-sector-lookup` sent Trading212's raw ticker (e.g. `AMD_US_EQ`)
// straight to Finnhub, which only recognizes the bare symbol (`AMD`) and silently
// returns an empty profile rather than erroring. The stage recorded that null result
// as `'success'` in the `work_items` ledger, so every currently-held ticker was
// treated as permanently done with no resolved industry — the stock-digest
// Diversification section stayed empty even with a valid FINNHUB_API_KEY.
//
// This script deletes those specific poisoned rows (success rows with
// `detail.industry === null`) so the corrected code re-resolves them — with the
// Trading212→Finnhub ticker translation now in place — on the next stock-digest run.
//
// IDEMPOTENT: a second run finds nothing left to remove (0 removed = already
// reconciled — no-op). It never touches any other job's ledger.
//
// Run (against the live data/jobs.db): `npx tsx scripts/reset-stock-sector-lookup-null-successes.ts`
// Point at a scratch DB with LOCALJOBS_DB=/tmp/foo.db to dry-test.
import { deleteNullDetailSuccessItems } from '../src/db/store.js';

const JOB_NAME = 'stock-sector-lookup';
const FIELD = 'industry';

console.log('── reset-stock-sector-lookup-null-successes ──\n');

const removed = deleteNullDetailSuccessItems(JOB_NAME, FIELD);

if (removed.length === 0) {
  console.log('0 removed — already reconciled (no poisoned rows found), no-op.');
} else {
  for (const ticker of removed) {
    console.log(`  removed: ${ticker}`);
  }
  console.log(`\nDone. Removed ${removed.length} poisoned row(s) — they will re-resolve on the next stock-digest run.`);
}
