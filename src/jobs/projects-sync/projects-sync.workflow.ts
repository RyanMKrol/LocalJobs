import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Projects-sync: fetch the owner's GitHub repos, apply fork/archived filter +
 * activity sort, and upsert the filtered list into the DynamoDB projects table.
 * Idempotent upsert keyed by GitHub repo numeric id (repoId) — re-scans every
 * run so field changes (stars, description, etc.) are refreshed.
 *
 * Runs daily at 05:00. Single stage; no fan-out needed for a simple list upsert.
 * NOT limitable — inputs are discovered live from GitHub each run.
 */
const workflow: WorkflowDefinition = {
  name: 'projects-sync',
  description:
    'Fetch GitHub repos, filter forks/archived, sort by activity, ' +
    'and upsert the filtered list to the DynamoDB projects table.',
  schedule: '0 5 * * *',
  maxConcurrency: 1,
  jobs: [{ job: 'github-sync' }],
};

export default workflow;
