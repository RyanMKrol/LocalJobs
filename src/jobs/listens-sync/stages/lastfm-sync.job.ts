import type { JobDefinition } from '../../../core/types.js';
import { runLastfmSync } from './lastfm-sync.js';

const job: JobDefinition = {
  name: 'lastfm-sync',
  description:
    'Fetch recent Last.fm scrobbles and write new ones to the DynamoDB listens table. ' +
    'Idempotent via the work_items ledger (keyed by trackId + scrobbledAt).',
  timeoutMs: 300_000,
  maxRetries: 3,
  async run(ctx) {
    await runLastfmSync(ctx);
  },
};

export default job;
