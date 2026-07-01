import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Workouts-sync: paginate the Hevy API and append each newly-synced workout's
 * full data (title, sets, exercises) to a local, full-history JSON file
 * (`data/out/workouts-history.json`). Idempotent — workouts already recorded
 * in the work_items ledger are skipped, so the history file only ever grows.
 *
 * Runs monthly (1st, 06:00) — a same-day-fresh cadence isn't needed now that
 * the sync no longer feeds DynamoDB.
 *
 * Stage 2, `workouts-progress` (`dependsOn: ['hevy-sync']`), reads the full
 * history file and computes a per-exercise 6-month progress comparison (best
 * single set, total volume, estimated 1-rep-max via the Epley formula) across
 * a baseline calendar month (6 months before the current period) vs the
 * current period (the most recently completed calendar month), writes the
 * raw comparison to `data/out/progress-data.json`, and uses the shared Claude
 * CLI helper to narrate it into `data/out/workouts-progress.md`. Idempotent
 * per calendar month via the work_items ledger (mirrors `listening-digest`) —
 * a manual re-run the same month regenerates the report rather than
 * duplicating it.
 */
const workflow: WorkflowDefinition = {
  name: 'workouts-sync',
  category: 'regular-maintenance',
  description:
    'Paginate Hevy workout API and append newly-synced workouts to a local full-history JSON file, ' +
    'then compute a monthly per-exercise 6-month progress report (best set / volume / est. 1RM) via Claude.',
  schedule: '0 6 1 * *',
  maxConcurrency: 1,
  jobs: [
    { job: 'hevy-sync' },
    { job: 'workouts-progress', dependsOn: ['hevy-sync'] },
  ],
};

export default workflow;
