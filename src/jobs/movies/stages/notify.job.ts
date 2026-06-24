import type { JobDefinition } from '../../../core/types.js';
import { franchiseGapsContract } from '../contracts.js';
import { runNotify } from './notify.js';

const job: JobDefinition = {
  name: 'movie-gaps-notify',
  description: 'Stage 3: digest-push the newly-detected franchise gaps you don\'t own (deduped per film; owner-ignored gaps excluded).',
  timeoutMs: 120_000,
  maxRetries: 3,
  consumes: [franchiseGapsContract()],
  async run(ctx) {
    await runNotify(ctx);
  },
};

export default job;
