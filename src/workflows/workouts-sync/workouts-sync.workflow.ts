import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Workouts-sync: two stages, `hevy-sync` then `workouts-progress`.
 *
 * Stage 1, `hevy-sync`, pages through the whole Hevy workout list and adds each
 * workout the work_items ledger does not already have (title, exercises, sets)
 * to a local history file, `data/out/workouts-history.json`. The file is saved
 * before the workouts are marked synced, so a kill in between cannot leave a
 * workout marked done but missing from the history. A workout is synced once
 * and the file is never pruned.
 *
 * Stage 2, `workouts-progress` (`dependsOn: ['hevy-sync']`), is handed that
 * history and computes a per-exercise 6-month comparison (best single set,
 * total volume, estimated 1-rep-max via the Epley formula): the most recently
 * completed calendar month against the month 6 months before it. It writes the
 * raw comparison to `data/out/progress-data.json` and uses the shared Claude
 * CLI helper to narrate it into `data/out/workouts-progress-<YYYY-MM>.md`, one
 * file per month so earlier reports survive. A re-run in the same month
 * rewrites that month's report. It records one ledger row per report month,
 * pointing at the file, which is what `vault-sync` reads to copy the report.
 *
 * Runs monthly (1st, 06:00). Nothing reads the result in real time, so a
 * fresher cadence is not needed. Not limitable: no stage declares inputKeys().
 */
const workflow: WorkflowDefinition = {
  name: 'workouts-sync',
  category: 'regular-maintenance',
  description:
    'Paginate Hevy workout API and append newly-synced workouts to a local full-history JSON file, ' +
    'then compute a monthly per-exercise 6-month progress report (best set / volume / est. 1RM) via Claude.',
  idempotencyNote: 'Each individual workout synced from Hevy is tracked by its own id and is never re-fetched once synced, so your workout history only ever grows; the monthly progress report is regenerated in place if you re-run it the same month.',
  schedule: '0 6 1 * *',
  maxConcurrency: 1,
  jobs: [
    { job: 'hevy-sync' },
    { job: 'workouts-progress', dependsOn: ['hevy-sync'] },
  ],
};

export default workflow;
