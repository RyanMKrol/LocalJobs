import type { JobDefinition } from '../../../core/types.js';
import { franchiseGapsContract, recommendationsContract } from '../contracts.js';
import { runNotify } from './notify.js';

const job: JobDefinition = {
  name: 'movie-gaps-notify',
  description: 'Final stage: ONE combined monthly digest + report — the newly-detected franchise gaps you don\'t own AND the TMDB-verified film recommendations (separate sections; deduped per film; owner-ignored items excluded).',
  timeoutMs: 120_000,
  maxRetries: 3,
  consumes: [franchiseGapsContract(), recommendationsContract()],
  async run(ctx) {
    await runNotify(ctx);
  },
};

export default job;
