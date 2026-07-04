import type { JobDefinition } from '../../../core/types.js';
import { franchiseGapsContract, movieSnapshotContract } from '../contracts.js';
import { runFranchiseGaps } from './franchise-gaps.js';

const job: JobDefinition = {
  name: 'franchise-gaps',
  description: 'Stage 2: detect franchise gaps via the TMDB Collections API — released franchise films you don\'t own (no quality filter).',
  timeoutMs: 1_800_000, // ~30 min headroom: ~1,500 /movie calls + collection fetches
  maxRetries: 3,
  consumes: [movieSnapshotContract()],
  produces: [franchiseGapsContract()],
  async run(ctx) {
    await runFranchiseGaps(ctx);
  },
};

export default job;
