import type { WorkflowDefinition } from '../../core/types.js';

/**
 * listens-backfill: one-time manual workflow to seed the DynamoDB listens table
 * with the owner's full Last.fm scrobble history.
 *
 * Run once after T254 deploys, then it is safe to leave disabled or re-run
 * at any time (idempotent via the shared work_items ledger). Not scheduled —
 * manual-only.
 */
const workflow: WorkflowDefinition = {
  name: 'listens-backfill',
  description:
    'One-time backfill of the full Last.fm scrobble history into the DynamoDB listens table. ' +
    'Idempotent — safe to re-run. Manual-only (no schedule).',
  schedule: null,
  maxConcurrency: 1,
  jobs: [{ job: 'lastfm-backfill' }],
};

export default workflow;
