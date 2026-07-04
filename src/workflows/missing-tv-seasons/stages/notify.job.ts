import type { JobDefinition } from '../../../core/types.js';
import { missingSeasonsContract } from '../contracts.js';
import { runNotify } from './notify.js';

const job: JobDefinition = {
  name: 'plex-seasons-notify',
  description: 'Stage 3: digest-push the newly-detected complete seasons you don\'t own (deduped per show+season).',
  timeoutMs: 120_000,
  maxRetries: 3,
  consumes: [missingSeasonsContract()],
  async run(ctx) {
    await runNotify(ctx);
  },
};

export default job;
