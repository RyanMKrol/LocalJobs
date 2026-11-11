import type { WorkflowDefinition } from '../../core/types.js';

/**
 * vercel-daily-redeploy: once a day, runs `vercel --prod --yes` directly in two
 * separate checkouts on this machine. Each is a real CLI production deploy of
 * that checkout's current working tree, not an HTTP call to a Vercel Deploy
 * Hook. A run of this workflow deploys two live sites.
 *
 * Two stages with no edge between them, run one after the other
 * (`maxConcurrency: 1`). Both use the same runner and each commits one inline
 * output, `result` (`vercel-redeploy-result`): deployed, skipped or failed.
 *
 * - `vercel-redeploy` deploys the `ryankrol.co.uk` checkout
 *   (`RYANKROL_CO_UK_PATH`). That repo deliberately disconnected its Vercel Git
 *   integration: its own autonomous harness was pushing a commit every few
 *   minutes, and even a cancelled deploy counted against the Hobby quota, so
 *   pushing to `main` no longer deploys anything. It ships through its own
 *   harness convention (a "deploy task" that runs `vercel --prod`). This stage
 *   is a separate daily safety net for when that fails or is forgotten. It does
 *   not replace it.
 * - `vercel-redeploy-pomodiary` deploys the `PomoDiary` checkout
 *   (`POMODIARY_PATH`). That repo turns off push-triggered deploys for the same
 *   reason, so for it this daily deploy is the primary way the site ships.
 *
 * Why the CLI and not a Deploy Hook: a hook builds from the connected Git repo
 * and branch, and with the integration off it may not fire at all.
 * `vercel --prod` deploys the local working tree whatever the state of the Git
 * integration.
 *
 * No credential to provision: the Vercel CLI already has a persistent login
 * session on this machine (`vercel whoami`), and the job relies on that instead
 * of a passed token. An unset env var, or a path that does not exist, makes that
 * stage skip cleanly.
 *
 * Scheduled late (23:00) so it runs after a typical day's activity.
 */
const workflow: WorkflowDefinition = {
  name: 'vercel-daily-redeploy',
  category: 'regular-maintenance',
  description:
    'Daily production deploys ("vercel --prod --yes") run directly via the Vercel CLI, independent ' +
    'of Git integration state: a safety net for ryankrol.co.uk, and the primary ship mechanism for ' +
    'PomoDiary (which disables push-triggered deploys to protect the Hobby deployment quota).',
  idempotencyNote: 'There\'s no per-item tracking here — this is a simple fire-and-forget daily deploy trigger with no items to track, gated only by a daily/monthly deploy-count budget.',
  schedule: '0 23 * * *',
  maxConcurrency: 1,
  jobs: [{ job: 'vercel-redeploy' }, { job: 'vercel-redeploy-pomodiary' }],
};

export default workflow;
