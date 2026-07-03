import type { JobDefinition } from '../../core/types.js';

const job: JobDefinition = {
  name: 'vercel-redeploy',
  description:
    'POST to a Vercel Deploy Hook to re-trigger a build of the ryankrol.co.uk site — a daily ' +
    'safety net in case Vercel per-commit auto-deploy rate limits dropped a deploy earlier in the day.',
  timeoutMs: 30_000,
  maxRetries: 1,
  async run(ctx) {
    const hookUrl = process.env.VERCEL_DEPLOY_HOOK_URL;
    if (!hookUrl) {
      ctx.log(
        'VERCEL_DEPLOY_HOOK_URL not configured — skipping redeploy trigger (see .env.example)',
        'warn',
      );
      return;
    }

    ctx.log('Triggering Vercel Deploy Hook redeploy for ryankrol.co.uk...');
    let res: Response;
    try {
      res = await fetch(hookUrl, { method: 'POST' });
    } catch (err) {
      ctx.log(`Deploy Hook request failed (network error): ${String(err)}`, 'error');
      throw err;
    }

    ctx.log(`Deploy Hook responded with status ${res.status}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const message = `Deploy Hook returned non-2xx status ${res.status}${body ? `: ${body}` : ''}`;
      ctx.log(message, 'error');
      throw new Error(message);
    }

    ctx.log('Redeploy triggered successfully — Vercel will build the latest commit on the hooked branch.');
  },
};

export default job;
