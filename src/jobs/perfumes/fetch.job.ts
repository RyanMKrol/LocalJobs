import type { JobDefinition } from '../../core/types.js';
import { fragranticaPagesContract, fragranticaUrlsContract } from './contracts.js';
import { runFetch } from './fetch.js';

const job: JobDefinition = {
  name: 'perfumes-fetch',
  description: 'Stage 2: headless browser captures each Fragrantica page\'s full text (scrolled).',
  timeoutMs: 0,
  maxRetries: 0,
  consumes: [fragranticaUrlsContract()],
  produces: [fragranticaPagesContract()],
  async run(ctx) { await runFetch(ctx); },
};

export default job;
