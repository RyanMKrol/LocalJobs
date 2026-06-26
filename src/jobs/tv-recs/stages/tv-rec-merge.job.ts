import type { JobDefinition } from '../../../core/types.js';
import { runTvRecMerge } from './tv-rec-merge.js';

const job: JobDefinition = {
  name: 'tv-rec-merge',
  description: 'Merge stage: pool the 8 TV recommender branches\' raw suggestions, TMDB-verify each (real TV show, un-owned, not previously recommended), dedupe across branches, and balance per genre into the final recommendation list.',
  timeoutMs: 1_800_000,
  maxRetries: 2,
  async run(ctx) {
    await runTvRecMerge(ctx);
  },
};

export default job;
