import type { WorkflowDefinition } from '../../core/types.js';

/**
 * TV show recommendations workflow — a standalone counterpart to the movie
 * recommendations workflow (`src/jobs/movies/`), scoped to TV shows.
 *
 * Scheduled MONTHLY (1st of the month, 09:00). Like the movies workflow, it is
 * NOT limitable (no inputKeys on any member) — inputs are discovered live from
 * Plex each run.
 *
 * Stages (T214 + T216): tv-snapshot + 8 recommender branches (3 random serendipity
 * + 5 targeted). Later tasks add a merge stage and notify stage.
 */
const workflow: WorkflowDefinition = {
  name: 'tv-recommendations',
  description: 'Snapshots your Plex TV library by GUID, builds a taste profile (genres/roles/decades/countries), fans out 8 Claude recommender branches, and — in a later stage — merges + pushes a monthly digest of TV show recommendations.',
  schedule: '0 9 1 * *',
  maxConcurrency: 4,
  jobs: [
    { job: 'tv-snapshot' },
    { job: 'tv-rec-random-1', dependsOn: ['tv-snapshot'] },
    { job: 'tv-rec-random-2', dependsOn: ['tv-snapshot'] },
    { job: 'tv-rec-random-3', dependsOn: ['tv-snapshot'] },
    { job: 'tv-rec-creator', dependsOn: ['tv-snapshot'] },
    { job: 'tv-rec-canon', dependsOn: ['tv-snapshot'] },
    { job: 'tv-rec-thin-genre', dependsOn: ['tv-snapshot'] },
    { job: 'tv-rec-older-era', dependsOn: ['tv-snapshot'] },
    { job: 'tv-rec-world', dependsOn: ['tv-snapshot'] },
  ],
};

export default workflow;
