import type { JobDefinition } from '../../../core/types.js';
import { runListensBackfill } from './listens-backfill.js';

const job: JobDefinition = {
  name: 'lastfm-backfill',
  description:
    'One-time backfill of the full Last.fm scrobble history into the DynamoDB listens table. ' +
    'Idempotent via the shared work_items ledger (same key shape as the live lastfm-sync). ' +
    'Manual-only — run once to seed the table, then leave disabled.',
  // Full history can be very large (thousands of pages at 200 tracks/page).
  // 6-hour timeout allows ~1000 pages at the lastfm service rate limit.
  timeoutMs: 6 * 60 * 60 * 1000,
  maxRetries: 3,
  async run(ctx) {
    await runListensBackfill(ctx);
  },
};

export default job;
