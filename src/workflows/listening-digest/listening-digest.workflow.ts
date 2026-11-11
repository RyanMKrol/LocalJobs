import type { WorkflowDefinition } from '../../core/types.js';

/**
 * listening-digest: a monthly pair of markdown digests of top albums and tracks
 * from Last.fm, one for period=1month and one for period=3month. Last.fm does
 * the aggregation, so no raw scrobbles are ingested. Single stage
 * (`lastfm-digest`). NOT limitable: no inputKeys().
 *
 * Runs on the 1st of the month at 06:00. A re-run in the same month rewrites
 * that month's two files in place. The stage records one work_items ledger row
 * per digest, keyed by month, which is what `vault-sync` reads to copy them.
 */
const workflow: WorkflowDefinition = {
  name: 'listening-digest',
  category: 'regular-maintenance',
  description:
    'Monthly markdown digests of top albums/tracks from Last.fm (one for the last month, one for ' +
    'the last three months), written to data/out/.',
  idempotencyNote: 'There\'s no per-item tracking here — this workflow tracks only which calendar month\'s digest has been generated, so re-running it in the same month just regenerates that month\'s two reports in place rather than duplicating them.',
  schedule: '0 6 1 * *',
  maxConcurrency: 1,
  jobs: [{ job: 'lastfm-digest' }],
};

export default workflow;
