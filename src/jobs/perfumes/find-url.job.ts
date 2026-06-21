import type { JobDefinition } from '../../core/types.js';
import { runFindUrl } from './find-url.js';

const job: JobDefinition = {
  name: 'perfumes-find-url',
  description: 'Stage 1: find each perfume\'s Fragrantica URL via Claude Code (web search).',
  instructions: 'Part of the perfumes pipeline. Usually run by "perfumes-pipeline"; can be run solo. Uses the `claude` CLI ($0 under the plan). Idempotent by perfume id.',
  schedule: null,
  timeoutMs: 0,
  maxRetries: 0,
  async run(ctx) { await runFindUrl(ctx); },
};

export default job;
