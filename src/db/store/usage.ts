import { db } from '../index.js';

// ---- usage meter (per-day / per-month spend caps) ----

/** Record one metered action (e.g. one external API call) against a job. */
export function recordUsage(jobName: string): void {
  db.prepare('INSERT INTO job_usage (job_name) VALUES (?)').run(jobName);
}

/** Actions recorded for a job since the start of the current UTC day. */
export function usageToday(jobName: string): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM job_usage WHERE job_name = ? AND ts >= datetime('now','start of day')",
  ).get(jobName) as { n: number }).n;
}

/** Actions recorded for a job since the start of the current UTC month. */
export function usageThisMonth(jobName: string): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM job_usage WHERE job_name = ? AND ts >= datetime('now','start of month')",
  ).get(jobName) as { n: number }).n;
}

/**
 * Check a job against its per-day and per-month caps. Returns how much headroom
 * is left and, if a cap is hit, a human-readable reason to log and stop on.
 */
export function capStatus(
  jobName: string,
  dailyCap: number,
  monthlyCap: number,
): { allowed: boolean; reason: string; today: number; month: number; dayLeft: number; monthLeft: number } {
  const today = usageToday(jobName);
  const month = usageThisMonth(jobName);
  const dayLeft = Math.max(0, dailyCap - today);
  const monthLeft = Math.max(0, monthlyCap - month);
  let reason = '';
  if (month >= monthlyCap) reason = `monthly cap reached (${month}/${monthlyCap})`;
  else if (today >= dailyCap) reason = `daily cap reached (${today}/${dailyCap})`;
  return { allowed: reason === '', reason, today, month, dayLeft, monthLeft };
}

/** Seed N usage rows for the current month (one-time backfill from a legacy counter). */
export function backfillMonthlyUsage(jobName: string, count: number): void {
  const insert = db.prepare('INSERT INTO job_usage (job_name) VALUES (?)');
  const tx = db.transaction((n: number) => { for (let i = 0; i < n; i++) insert.run(jobName); });
  tx(count);
}
