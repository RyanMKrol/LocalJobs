import type { WorkflowDefinition } from '../../core/types.js';

/**
 * vercel-daily-redeploy: once a day, POST to a Vercel Deploy Hook for the
 * separate ryankrol.co.uk repo.
 *
 * WHY: that repo's own autonomous build harness can push enough commits in a
 * day to exceed Vercel's per-commit auto-deploy rate limits, silently
 * dropping some deploys. This is a safety net so the live site is never more
 * than 24h behind the latest pushed commit, regardless of how many deploys
 * got dropped upstream. Scheduled late (23:00) so it runs after a typical
 * day's push activity.
 *
 * VERCEL_DEPLOY_HOOK_URL is optional — unset soft-skips the job cleanly (the
 * hook must be provisioned manually in the Vercel dashboard).
 */
const workflow: WorkflowDefinition = {
  name: 'vercel-daily-redeploy',
  category: 'regular-maintenance',
  description:
    'Daily safety-net POST to a Vercel Deploy Hook for ryankrol.co.uk, so the live site is never ' +
    'more than 24h behind the latest pushed commit even if per-commit auto-deploys were rate-limited.',
  schedule: '0 23 * * *',
  maxConcurrency: 1,
  jobs: [{ job: 'vercel-redeploy' }],
};

export default workflow;
