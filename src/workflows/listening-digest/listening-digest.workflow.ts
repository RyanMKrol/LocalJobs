import type { WorkflowDefinition } from '../../core/types.js';

/**
 * listening-digest: monthly markdown digest of top albums/tracks from Last.fm
 * (period=1month, aggregated server-side by Last.fm — no raw scrobble
 * ingestion needed). Single stage. NOT limitable: nothing to fan out over.
 *
 * Runs once a month; a manual re-run the same month simply regenerates that
 * month's markdown file (idempotent via the work_items ledger keyed by
 * calendar month).
 */
const workflow: WorkflowDefinition = {
  name: 'listening-digest',
  category: 'regular-maintenance',
  description:
    'Monthly markdown digest of top albums/tracks from Last.fm (period=1month), written to data/out/.',
  idempotencyNote: 'There\'s no per-item tracking here — this workflow tracks only which calendar month\'s digest has been generated, so re-running it in the same month just regenerates that month\'s two reports in place rather than duplicating them.',
  schedule: '0 6 1 * *',
  maxConcurrency: 1,
  jobs: [{ job: 'lastfm-digest' }],
};

export default workflow;
