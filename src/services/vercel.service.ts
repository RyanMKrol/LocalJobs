import { defineService } from './lib.js';

/** Vercel CLI — direct production deploy trigger for the ryankrol.co.uk checkout (a daily
 *  safety-net, see vercel-daily-redeploy). Free (Hobby plan) — the concern is quota
 *  exhaustion, not billing, so `paid` is false. This is designed to run at most once a
 *  day (the workflow's own cron), so the caps are set conservatively — high enough that
 *  a scheduled run plus a couple of manual re-runs the same day never trip them, low
 *  enough to catch a genuine scheduling bug that fires repeatedly. No `ratePerMinute` /
 *  `minIntervalMs`: a deploy itself takes minutes (the job's own 11-minute timeout), so a
 *  per-minute/interval throttle is meaningless here — the day/month caps are the only
 *  meaningful governor. */
const service = defineService({
  name: 'vercel',
  category: 'cli-tool',
  description: 'Vercel CLI ("vercel --prod --yes") — direct production deploy trigger for the ryankrol.co.uk checkout (a daily safety-net, see vercel-daily-redeploy).',
  envPrefix: 'VERCEL',
  dailyCap: { fallback: 3 },
  monthlyCap: { fallback: 30 },
  paid: false,
  rateLimitSource:
    'No public Vercel CLI deploy-rate documentation applies here (this is a personal Hobby-plan ' +
    'checkout, not a metered API) — dailyCap=3 / monthlyCap=30 are our own conservative estimates, ' +
    'sized so a single scheduled daily deploy plus a couple of manual re-runs the same day never ' +
    'trip them, while still catching a genuine scheduling bug that fires repeatedly.',
});

export default service;
