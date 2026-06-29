import type { WorkflowDefinition } from '../../core/types.js';

/**
 * listens-sync: fetch recent Last.fm scrobbles and write each to the DynamoDB
 * listens table (PK: trackId, SK: scrobbledAt). Idempotent — scrobbles already
 * in the work_items ledger are skipped. Optional Spotify enrichment for album art.
 *
 * Runs daily at 07:00. Single stage (linear pipeline; no fan-out needed).
 * NOT limitable — scrobbles are discovered live from Last.fm each run.
 */
const workflow: WorkflowDefinition = {
  name: 'listens-sync',
  description:
    'Fetch recent Last.fm scrobbles and write them to the DynamoDB listens table. ' +
    'Idempotent per (trackId, scrobbledAt) via the work_items ledger.',
  schedule: '0 7 * * *',
  maxConcurrency: 1,
  jobs: [{ job: 'lastfm-sync' }],
};

export default workflow;
