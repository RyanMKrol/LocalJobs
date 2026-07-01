import type { JobDefinition } from '../../../core/types.js';
import { runProjectSummarize } from './project-summarize.js';

const job: JobDefinition = {
  name: 'project-summarize',
  description:
    'Shallow-clone each cataloged repo and use the Claude CLI to write a one-project ' +
    'markdown summary to data/out/<repo-name>.md. Idempotent per repo — skips a repo whose ' +
    'last-processed marker (pushedAt) already matches the catalog value.',
  timeoutMs: 600_000,
  maxRetries: 2,
  async run(ctx) {
    await runProjectSummarize(ctx);
  },
};

export default job;
