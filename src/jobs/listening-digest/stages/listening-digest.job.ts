import type { JobDefinition } from '../../../core/types.js';
import { runListeningDigest } from './listening-digest.js';

const job: JobDefinition = {
  name: 'lastfm-digest',
  description:
    'Build a monthly markdown digest of top albums/tracks from Last.fm (period=1month) and ' +
    'write it to data/out/. Idempotent per calendar month via the work_items ledger.',
  timeoutMs: 60_000,
  maxRetries: 3,
  async run(ctx) {
    await runListeningDigest(ctx);
  },
};

export default job;
