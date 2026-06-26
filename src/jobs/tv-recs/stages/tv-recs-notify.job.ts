import type { JobDefinition } from '../../../core/types.js';
import { runTvRecsNotify } from './tv-recs-notify.js';

const job: JobDefinition = {
  name: 'tv-recs-notify',
  description: 'Final stage: ONE monthly digest of newly-verified TV show recommendations (owner-ignored + already-notified excluded; each pick announced exactly once).',
  timeoutMs: 120_000,
  maxRetries: 3,
  async run(ctx) {
    await runTvRecsNotify(ctx);
  },
};

export default job;
