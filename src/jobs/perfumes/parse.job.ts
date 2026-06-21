import type { JobDefinition } from '../../core/types.js';
import { runParse } from './parse.js';

const job: JobDefinition = {
  name: 'perfumes-parse',
  description: 'Stage 3: Claude Code parses each captured page into structured Fragrantica JSON.',
  instructions: 'Part of the perfumes pipeline. Reads data/out/pages/<id>.txt → data/out/fragrantica/<id>.json. No web needed. Idempotent by perfume id.',
  schedule: null,
  timeoutMs: 0,
  maxRetries: 0,
  async run(ctx) { await runParse(ctx); },
};

export default job;
