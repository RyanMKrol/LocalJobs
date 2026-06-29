import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Workouts-sync: paginate the Hevy API and write each workout + its exercises
 * into the existing DynamoDB tables the website uses. Idempotent — workouts
 * already recorded in the work_items ledger are skipped.
 *
 * Runs daily at 06:00. Single stage (serial; no fan-out needed for a simple
 * append pipeline). The job is NOT limitable — inputs are discovered live from
 * the Hevy API each run, not a static file (like the plex audit workflows).
 */
const workflow: WorkflowDefinition = {
  name: 'workouts-sync',
  description:
    'Paginate Hevy workout API and write workouts + exercises into DynamoDB. ' +
    'Idempotent per workout id via the work_items ledger.',
  schedule: '0 6 * * *',
  maxConcurrency: 1,
  jobs: [{ job: 'hevy-sync' }],
};

export default workflow;
