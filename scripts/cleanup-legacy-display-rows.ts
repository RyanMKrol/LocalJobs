// One-off cleanup: delete ledger rows that existed only to be displayed.
//
// Before a workflow is on ports, the dashboard's Output section could only list
// ledger rows, so a stage that writes one report wrote a ledger row per run (or
// per week) pointing at it. A ports stage declares that report as an output
// instead, and the Output section shows it as an artifact card. The old rows are
// then noise: they sit under the card, every one of them opening the same file.
//
// This deletes the WHOLE ledger of each job listed below. A job belongs on the
// list only if (a) its stage is now a ports stage, and (b) nothing reads that
// ledger: it is not an idempotency record, not an "already announced" record,
// not a catalogue another workflow mirrors. Add a job when its workflow is
// migrated and its rows are confirmed to be display-only.
//
// Old runs of these stages lose their Inputs & Outputs rows (the rows are what
// is being deleted). Their status, timings and logs are untouched.
//
// DRY RUN by default: prints what it would delete. Pass --apply to delete.
// Safe to re-run: a second run finds nothing.
//   npx tsx scripts/cleanup-legacy-display-rows.ts [--apply]
import { deleteLedgerOfJob, ledgerSize } from '../src/db/store.js';

const DISPLAY_ONLY_LEDGERS: { job: string; was: string }[] = [
  { job: 'overrides-audit-scan', was: 'one row per ISO week pointing at stale-overrides.json' },
  { job: 'plex-space-saver-scan', was: 'one row per ISO week pointing at size-breakdown.json' },
  { job: 'mount-keeper-check', was: 'one row per share, re-marked every hour' },
  // The alert dedupe ledger is a different job name (plex-library-guard-alert) and is kept.
  { job: 'plex-library-guard-scan', was: 'one row per day pointing at guard-report.json, plus a "snapshot" row' },
];

const apply = process.argv.includes('--apply');
console.log(`── cleanup-legacy-display-rows (${apply ? 'APPLY' : 'dry run'}) ──\n`);
let total = 0;
for (const { job, was } of DISPLAY_ONLY_LEDGERS) {
  const size = ledgerSize(job);
  total += size.workItems + size.workItemRuns;
  if (!apply) {
    console.log(`${job}: would delete ${size.workItems} ledger row(s) and ${size.workItemRuns} per-run record(s)  (${was})`);
    continue;
  }
  const removed = deleteLedgerOfJob(job);
  console.log(`${job}: deleted ${removed.workItems} ledger row(s) and ${removed.workItemRuns} per-run record(s)  (${was})`);
}
console.log(total === 0 ? '\nNothing to delete: already clean.' : apply ? '\nDone.' : '\nDry run only. Re-run with --apply to delete.');
