import type { ServiceDefinition } from '../core/types.js';

/** Vercel CLI — direct production deploy trigger for the ryankrol.co.uk checkout (a daily
 *  safety-net, see vercel-daily-redeploy). Free (Hobby plan) — the concern is quota
 *  exhaustion, not billing, so `paid` is false. This is designed to run at most once a
 *  day (the workflow's own cron), so the caps are set conservatively — high enough that
 *  a scheduled run plus a couple of manual re-runs the same day never trip them, low
 *  enough to catch a genuine scheduling bug that fires repeatedly. No `ratePerMinute` /
 *  `minIntervalMs`: a deploy itself takes minutes (the job's own 11-minute timeout), so a
 *  per-minute/interval throttle is meaningless here — the day/month caps are the only
 *  meaningful governor. */
const service: ServiceDefinition = {
  name: 'vercel',
  category: 'cli-tool',
  description: 'Vercel CLI ("vercel --prod --yes") — direct production deploy trigger for the ryankrol.co.uk checkout (a daily safety-net, see vercel-daily-redeploy).',
  dailyCap: Number(process.env.VERCEL_DAILY_CAP ?? 3),
  monthlyCap: Number(process.env.VERCEL_MONTHLY_CAP ?? 30),
  paid: false,
};

export default service;
