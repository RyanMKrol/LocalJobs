import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Projects-sync: fetch the owner's GitHub repos, apply fork/archived filter +
 * activity sort, and write the filtered list to a local data/out/projects.json
 * catalog. Idempotent per GitHub repo numeric id (repoId) — re-scans every run
 * so the catalog reflects the latest fields (description, topics, etc.).
 *
 * Runs weekly, Sunday at 05:00. Single stage; no fan-out needed for a simple
 * list catalog.
 */
const workflow: WorkflowDefinition = {
  name: 'projects-sync',
  description:
    'Fetch GitHub repos, filter forks/archived, sort by activity, ' +
    'and write the filtered catalog to data/out/projects.json.',
  schedule: '0 5 * * 0',
  maxConcurrency: 1,
  jobs: [{ job: 'github-sync' }],
};

export default workflow;
