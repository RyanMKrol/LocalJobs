// One-off admin cleanup: remove the stale `listens-backfill`/`listens-sync`
// workflows, their `lastfm-backfill`/`lastfm-sync` jobs, and the orphaned
// `spotify` service from data/jobs.db.
//
// WHY: these are pure leftover DB rows from an old, since-rewritten Last.fm/
// Spotify sync design, superseded by the current `listening-digest`
// (`lastfm-digest`) workflow. No `*.job.ts` / `*.workflow.ts` / `*.service.ts`
// exists anywhere under src/ for any of these four identifiers — the rows are
// dead weight, shadow-listed on the dashboard's Workflows/Services pages.
//
// This does NOT touch `src/jobs/listening-digest/**` or the `lastfm` service —
// that is unrelated, current code.
//
// IDEMPOTENT — safe to re-run. A second run reports zero rows deleted for
// every identifier. Local-SQLite-only: no paid/remote API calls.
//
// Run (against the live data/jobs.db): `npx tsx scripts/cleanup-listens-spotify.ts`
// Point at a scratch DB with LOCALJOBS_DB=/tmp/foo.db to dry-test.
import {
  deleteJobCompletely,
  deleteServiceCompletely,
  deleteWorkflowCompletely,
} from '../src/db/store.js';

console.log('── cleanup-listens-spotify ──\n');

let anyDeleted = false;

for (const name of ['listens-backfill', 'listens-sync']) {
  const r = deleteWorkflowCompletely(name);
  console.log(`workflow ${name}`);
  console.log(`  workflows:         ${r.workflows}`);
  console.log(`  workflow_jobs:     ${r.workflowJobs}`);
  console.log(`  workflow_runs:     ${r.workflowRuns}`);
  console.log(`  workflow_run_logs: ${r.workflowRunLogs}\n`);
  if (Object.values(r).some((n) => n > 0)) anyDeleted = true;
}

for (const name of ['lastfm-backfill', 'lastfm-sync']) {
  const r = deleteJobCompletely(name);
  console.log(`job ${name}`);
  console.log(`  jobs:           ${r.jobs}`);
  console.log(`  runs:           ${r.runs}`);
  console.log(`  run_logs:       ${r.runLogs}`);
  console.log(`  work_items:     ${r.workItems}`);
  console.log(`  work_item_runs: ${r.workItemRuns}\n`);
  if (Object.values(r).some((n) => n > 0)) anyDeleted = true;
}

{
  const r = deleteServiceCompletely('spotify');
  console.log('service spotify');
  console.log(`  services:          ${r.services}`);
  console.log(`  service_consumers: ${r.serviceConsumers}`);
  console.log(`  service_usage:     ${r.serviceUsage}\n`);
  if (Object.values(r).some((n) => n > 0)) anyDeleted = true;
}

console.log(anyDeleted ? 'done — rows removed.' : 'done — nothing to remove (already clean, idempotent no-op).');
