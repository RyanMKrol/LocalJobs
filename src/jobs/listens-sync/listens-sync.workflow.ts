import type { WorkflowDefinition } from '../../core/types.js';

/**
 * listens-sync: fetch recent Last.fm scrobbles and write them to DynamoDB.
 * Optionally enriches album art via the Spotify API. Idempotent per
 * (trackId, scrobbledAt) via the work_items ledger.
 *
 * Runs every 4 hours. Single stage — no fan-out needed for a simple forward
 * sync. NOT limitable: inputs are discovered live from the Last.fm API each
 * run (like the plex audit workflows).
 */
const workflow: WorkflowDefinition = {
  name: 'listens-sync',
  description:
    'Fetch recent Last.fm scrobbles and write to the DynamoDB listens table. ' +
    'Optionally enriches album art via Spotify. Idempotent per (trackId, scrobbledAt).',
  schedule: '0 */4 * * *',
  maxConcurrency: 1,
  jobs: [{ job: 'lastfm-sync' }],
};

export default workflow;
