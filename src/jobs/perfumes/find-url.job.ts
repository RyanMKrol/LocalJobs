import type { JobDefinition } from '../../core/types.js';
import { fragranticaUrlsContract } from './contracts.js';
import { runFindUrl } from './find-url.js';

const job: JobDefinition = {
  name: 'perfumes-find-url',
  description: 'Stage 1: find each perfume\'s Fragrantica URL via Claude Code (web search).',
  instructions: 'Part of the perfumes workflow. Usually run by "perfumes-workflow"; can be run solo. Uses the `claude` CLI ($0 under the plan). Idempotent by perfume id.',
  schedule: null,
  timeoutMs: 0,
  maxRetries: 0,
  produces: [fragranticaUrlsContract()],
  async run(ctx) { await runFindUrl(ctx); },
};

export default job;
