import type { WorkflowDefinition } from '../../core/types.js';

/**
 * vercel-daily-redeploy: once a day, runs `vercel --prod --yes` directly in the
 * separate `ryankrol.co.uk` checkout — a real CLI production deploy, not an HTTP
 * call to a Vercel Deploy Hook (that was the original design; changed after
 * discovering the actual current situation, see below).
 *
 * WHY (revised 2026-07-03): `ryankrol.co.uk` deliberately DISCONNECTED its Vercel
 * Git integration on 2026-07-03 — pushing to `main` no longer auto-deploys
 * anything (that repo's own autonomous harness was pushing a commit every few
 * minutes, and even a *cancelled* deploy still counted against Hobby's quota, so
 * cancelling wasn't enough — the Git connection itself had to come off). That
 * repo now ships via its OWN harness convention: a single always-at-most-one
 * "deploy task" in ITS `.harness/TASKS.json` that runs `vercel --prod` directly.
 * This workflow is a SEPARATE, redundant daily safety net for when that
 * mechanism fails or a session forgets to author a deploy task — it does NOT
 * replace it. A Vercel Deploy Hook was the original plan (T365 in this repo's
 * backlog) but is no longer viable: Deploy Hooks build from the connected Git
 * repo/branch, and with Git integration off there's real doubt one would even
 * fire. `vercel --prod` sidesteps that entirely — it deploys the current local
 * working tree directly, independent of Git integration state (confirmed in
 * `ryankrol.co.uk`'s own `CLAUDE.md` "Deploying" section).
 *
 * No new credential to provision: the Vercel CLI is already installed and has a
 * persistent login session on this machine (`vercel whoami` — confirmed working
 * 2026-07-03), and `~/Development/ryankrol.co.uk/.vercel/project.json` is already
 * linked to the project — `vercel-redeploy.job.ts` relies on that existing global
 * CLI auth rather than a passed token. `RYANKROL_CO_UK_PATH` (the checkout path)
 * is the only required env var; unset or a nonexistent path soft-skips cleanly.
 *
 * Scheduled late (23:00) so it runs after a typical day's activity, same cadence
 * as the original design.
 */
const workflow: WorkflowDefinition = {
  name: 'vercel-daily-redeploy',
  category: 'regular-maintenance',
  description:
    'Daily safety-net production deploy ("vercel --prod --yes") for ryankrol.co.uk, run directly ' +
    'via the Vercel CLI, independent of that repo\'s own deploy-task mechanism or Git integration state.',
  schedule: '0 23 * * *',
  maxConcurrency: 1,
  jobs: [{ job: 'vercel-redeploy' }],
};

export default workflow;
