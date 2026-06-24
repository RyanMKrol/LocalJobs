import type { JobDefinition } from '../../../core/types.js';
import { recommendationsContract } from '../contracts.js';
import { runMerge } from './merge.js';

const job: JobDefinition = {
  name: 'rec-merge',
  description: 'Merge stage: pool the 8 branches\' raw film suggestions, TMDB-verify each (real, un-owned, not previously recommended), dedupe across branches, and balance per genre into the final recommendation list.',
  timeoutMs: 1_800_000, // ~30 min headroom for TMDB title searches
  maxRetries: 2,
  produces: [recommendationsContract()],
  async run(ctx) {
    await runMerge(ctx);
  },
};

export default job;
