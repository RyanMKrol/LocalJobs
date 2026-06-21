import type { JobDefinition } from '../../core/types.js';
import { fragranticaDataContract } from './contracts.js';
import { runBuild } from './build.js';

const job: JobDefinition = {
  name: 'perfumes-build',
  description: 'Stage 4: Claude Code combines Fragrantica data + research into a template-compliant profile.',
  instructions: 'Part of the perfumes pipeline. Reads data/out/fragrantica/<id>.json → data/out/markdown/<id>.md, following perfume-markdown\'s _TEMPLATE.md. Idempotent by perfume id.',
  schedule: null,
  timeoutMs: 0,
  maxRetries: 0,
  consumes: [fragranticaDataContract()],
  async run(ctx) { await runBuild(ctx); },
};

export default job;
