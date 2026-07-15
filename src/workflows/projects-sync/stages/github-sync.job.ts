import type { JobDefinition } from '../../../core/types.js';
import { runGithubSync, githubSyncInputKeys } from './github-sync.js';
import { projectsCatalogContract } from '../contracts.js';

const job: JobDefinition = {
  name: 'github-sync',
  description:
    'Fetches the owner\'s repositories from the GitHub REST API (GET /users/<GITHUB_USERNAME>/repos), ' +
    'filters out forks, archived repos, and private repos, then sorts the remainder by pushed_at ' +
    'descending and writes the result to data/out/projects.json. Each paginated API request is routed ' +
    'through the shared github service so its rate limit and quota are shared with the ' +
    'project-summarize stage\'s clone/fetch calls. The job re-scans and re-records every cataloged ' +
    'repo on every run (keyed by the repo\'s numeric GitHub id via the work_items ledger) rather than ' +
    'skipping already-seen ones, since fields like description, topics, and pushed_at can change on an ' +
    'existing repo and need to stay fresh for the downstream summarize stage.',
  timeoutMs: 120_000,
  maxRetries: 3,
  inputKeysService: 'github',
  inputKeys: githubSyncInputKeys,
  produces: [projectsCatalogContract()],
  async run(ctx) {
    await runGithubSync(ctx);
  },
};

export default job;
