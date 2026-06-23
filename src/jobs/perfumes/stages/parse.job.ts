import type { JobDefinition } from '../../../core/types.js';
import { fragranticaDataContract, fragranticaPagesContract } from '../contracts.js';
import { runParse } from './parse.js';

const job: JobDefinition = {
  name: 'perfumes-parse',
  description: 'Stage 3: Claude Code parses each captured page into structured Fragrantica JSON.',
  timeoutMs: 0,
  maxRetries: 3,
  consumes: [fragranticaPagesContract()],
  produces: [fragranticaDataContract()],
  async run(ctx) { await runParse(ctx); },
};

export default job;
