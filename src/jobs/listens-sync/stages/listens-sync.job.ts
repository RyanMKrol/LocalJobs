import type { JobDefinition } from '../../../core/types.js';
import { runListensSync } from './listens-sync.js';

const job: JobDefinition = {
  name: 'lastfm-sync',
  description:
    'Fetch recent Last.fm scrobbles and write them to the DynamoDB listens table. ' +
    'Optional Spotify enrichment for album art. Idempotent via the work_items ledger.',
  timeoutMs: 300_000,
  maxRetries: 3,
  async run(ctx) {
    await runListensSync(ctx);
  },
};

export default job;
