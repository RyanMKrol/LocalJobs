import type { JobDefinition } from '../../core/types.js';
import { fragranticaDataContract } from './contracts.js';
import { runBuild } from './build.js';

const job: JobDefinition = {
  name: 'perfumes-build',
  description: 'Stage 4: Claude Code combines Fragrantica data + research into a template-compliant profile.',
  timeoutMs: 0,
  maxRetries: 0,
  consumes: [fragranticaDataContract()],
  async run(ctx) { await runBuild(ctx); },
};

export default job;
