import type { WorkflowDefinition } from '../../core/types.js';

/**
 * Projects-sync: fetch the owner's GitHub repos, apply fork/archived filter +
 * activity sort, and write the filtered list to a local data/out/projects.json
 * catalog (stage 1, `github-sync`). Idempotent per GitHub repo numeric id
 * (repoId) — re-scans every run so the catalog reflects the latest fields
 * (description, topics, etc.).
 *
 * Stage 2, `project-summarize`, shallow-clones each cataloged repo and uses the
 * shared Claude CLI helper to write a one-project markdown summary to
 * data/out/<repo-name>.md. Idempotent per repo via a commit-sha-equivalent
 * marker (the catalog's `pushedAt`) — a repo whose stored marker already
 * matches the catalog's current value is skipped (no clone, no Claude call).
 *
 * Runs weekly, Sunday at 05:00.
 */
const workflow: WorkflowDefinition = {
  name: 'projects-sync',
  description:
    'Fetch GitHub repos, filter forks/archived, sort by activity, write the filtered ' +
    'catalog to data/out/projects.json, then clone + Claude-summarize each repo into ' +
    'a one-project markdown report.',
  schedule: '0 5 * * 0',
  maxConcurrency: 1,
  jobs: [
    { job: 'github-sync' },
    { job: 'project-summarize', dependsOn: ['github-sync'] },
  ],
};

export default workflow;
