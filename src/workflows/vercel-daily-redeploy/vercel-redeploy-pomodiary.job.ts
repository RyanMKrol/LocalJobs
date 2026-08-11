import type { JobDefinition } from '../../core/types.js';

import { POMODIARY_TARGET, runVercelRedeploy } from './vercel-redeploy.job.js';

/**
 * The PomoDiary twin of vercel-redeploy: same runner, different target. That
 * repo disconnected push-triggered Vercel deploys for the same reason
 * ryankrol.co.uk did (its build sessions push many commits a day, and each
 * auto-deploy burned Hobby quota), so this daily CLI deploy of the current
 * working tree is now its production ship mechanism.
 */
const job: JobDefinition = {
  name: 'vercel-redeploy-pomodiary',
  description:
    'Once a day this job runs "vercel --prod --yes" directly in the separate PomoDiary checkout, ' +
    'deploying that repo\'s current working tree to production. PomoDiary disables push-triggered ' +
    'Vercel deployments (vercel.json git.deploymentEnabled=false) because its agent-driven build ' +
    'sessions can push many commits per day and each auto-deploy counted against the Hobby ' +
    'deployment quota, so this daily CLI deploy is the production ship mechanism, not just a ' +
    'safety net. It relies on the Vercel CLI\'s existing persistent login session on this machine. ' +
    'The checkout path comes from the POMODIARY_PATH env var — if that var is unset or points at a ' +
    'path that does not exist on disk, the job logs a warning and soft-skips rather than failing. ' +
    'The spawned "vercel" process has the same internal 10-minute timeout-and-kill as the ' +
    'ryankrol.co.uk job.',
  timeoutMs: 660_000,
  maxRetries: 1,
  async run(ctx) {
    await runVercelRedeploy(ctx, { target: POMODIARY_TARGET });
  },
};

export default job;
