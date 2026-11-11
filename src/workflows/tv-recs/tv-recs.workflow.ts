import type { WorkflowDefinition } from '../../core/types.js';

/**
 * TV show recommendations workflow — a standalone counterpart to the movie
 * recommendations workflow (`src/workflows/movies/`), scoped to TV shows.
 *
 * Scheduled MONTHLY (1st of the month, 09:00). Like the movies workflow, it is
 * NOT limitable (no inputKeys on any member) — inputs are discovered live from
 * Plex each run.
 *
 * Stages (T214 + T216 + T217 + T218): tv-snapshot + 8 recommender branches (3 random
 * serendipity + 5 targeted) + tv-rec-merge (TMDB-verify, dedupe, quality bar,
 * balance, top-up) + tv-recs-notify (monthly digest push + report).
 *
 * The only ledger is `tv-recs`, keyed by tmdb id: tv-recs-notify writes it, and
 * the branches and the merge read it. It records which shows have been
 * announced or dismissed, not work done.
 */
const workflow: WorkflowDefinition = {
  name: 'tv-recommendations',
  category: 'recommendations',
  description: 'Snapshots your Plex TV library by GUID, builds a taste profile (genres/roles/decades/countries), fans out 8 Claude recommender branches, TMDB-verifies + merges the picks, and pushes a monthly digest of TV show recommendations.',
  idempotencyNote: 'Your Plex library is re-scanned and every recommendation branch re-runs fresh each month; only the final notify step tracks which recommended shows you\'ve already been told about or have dismissed, so a show is never recommended to you twice unless you un-dismiss it.',
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
    {
      job: 'tv-rec-merge',
      // The merge reads the snapshot and taste profile itself (to drop shows already
      // owned, and to re-prompt when short), so it depends on tv-snapshot directly
      // as well as on every branch. Every read is an edge; none is hidden.
      dependsOn: [
        'tv-snapshot',
        'tv-rec-random-1', 'tv-rec-random-2', 'tv-rec-random-3',
        'tv-rec-creator', 'tv-rec-canon', 'tv-rec-thin-genre',
        'tv-rec-older-era', 'tv-rec-world',
      ],
    },
    { job: 'tv-recs-notify', dependsOn: ['tv-rec-merge'] },
  ],
};

export default workflow;
