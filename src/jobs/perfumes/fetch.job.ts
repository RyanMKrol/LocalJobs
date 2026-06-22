import type { JobDefinition } from '../../core/types.js';
import { fragranticaPagesContract, fragranticaUrlsContract } from './contracts.js';
import { runFetch } from './fetch.js';

const job: JobDefinition = {
  name: 'perfumes-fetch',
  description: 'Stage 2: headless browser captures each Fragrantica page\'s full text (scrolled).',
  instructions: 'Part of the perfumes workflow. Reuses the Playwright headless setup — fetches Fragrantica un-blocked. Idempotent by perfume id.',
  schedule: null,
  timeoutMs: 0,
  maxRetries: 0,
  consumes: [fragranticaUrlsContract()],
  produces: [fragranticaPagesContract()],
  async run(ctx) { await runFetch(ctx); },
};

export default job;
