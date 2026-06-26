import type { WorkflowDefinition } from '../../core/types.js';

/**
 * TV show recommendations workflow — a standalone counterpart to the movie
 * recommendations workflow (`src/jobs/movies/`), scoped to TV shows.
 *
 * Scheduled MONTHLY (1st of the month, 09:00). Like the movies workflow, it is
 * NOT limitable (no inputKeys on any member) — inputs are discovered live from
 * Plex each run.
 *
 * Current stages (T214): tv-snapshot only. Later tasks will add recommender
 * branches, a merge stage, and a notify stage in the same fan-out pattern the
 * movies workflow uses (maxConcurrency 4 ready for that expansion).
 */
const workflow: WorkflowDefinition = {
  name: 'tv-recommendations',
  description: 'Snapshots your Plex TV library by GUID, builds a taste profile (genres/roles/decades/countries), and — in later stages — fans out Claude recommender branches and pushes a monthly digest of TV show recommendations.',
  schedule: '0 9 1 * *',
  maxConcurrency: 4,
  jobs: [
    { job: 'tv-snapshot' },
  ],
};

export default workflow;
