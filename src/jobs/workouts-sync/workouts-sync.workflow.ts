import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Workouts-sync: paginate the Hevy API and append each newly-synced workout's
 * full data (title, sets, exercises) to a local, full-history JSON file
 * (`data/out/workouts-history.json`). Idempotent — workouts already recorded
 * in the work_items ledger are skipped, so the history file only ever grows.
 *
 * Runs monthly (1st, 06:00) — a same-day-fresh cadence isn't needed now that
 * the sync no longer feeds DynamoDB; a future analysis stage (T299) will read
 * the full history file to compute long-range per-exercise progress trends.
 * Single stage (serial; no fan-out needed for a simple append pipeline). The
 * job is NOT limitable — inputs are discovered live from the Hevy API each
 * run, not a static file (like the plex audit workflows).
 */
const workflow: WorkflowDefinition = {
  name: 'workouts-sync',
  category: 'regular-maintenance',
  description:
    'Paginate Hevy workout API and append newly-synced workouts to a local full-history JSON file. ' +
    'Idempotent per workout id via the work_items ledger.',
  schedule: '0 6 1 * *',
  maxConcurrency: 1,
  jobs: [{ job: 'hevy-sync' }],
};

export default workflow;
