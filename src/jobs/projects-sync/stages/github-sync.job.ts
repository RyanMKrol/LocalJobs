import type { JobDefinition } from '../../../core/types.js';
import { runGithubSync } from './github-sync.js';

const job: JobDefinition = {
  name: 'github-sync',
  description:
    'Fetch GitHub repos, filter forks/archived, sort by activity, ' +
    'and upsert each to the DynamoDB projects table. Idempotent per repoId.',
  timeoutMs: 120_000,
  maxRetries: 3,
  async run(ctx) {
    await runGithubSync(ctx);
  },
};

export default job;
