import type { JobDefinition } from '../../../core/types.js';
import { runGithubSync, githubSyncInputKeys } from './github-sync.js';
import { projectsCatalogContract } from '../contracts.js';

const job: JobDefinition = {
  name: 'github-sync',
  description:
    'Fetch GitHub repos, filter forks/archived/private, sort by activity, ' +
    'and write the filtered catalog to data/out/projects.json. Idempotent per repoId.',
  timeoutMs: 120_000,
  maxRetries: 3,
  inputKeys: githubSyncInputKeys,
  produces: [projectsCatalogContract()],
  async run(ctx) {
    await runGithubSync(ctx);
  },
};

export default job;
