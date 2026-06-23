/**
 * Shared spend-cap math for the top-level services.
 *
 * Paid services are governed on a DAILY-scheduled cadence, so the daily spend cap
 * must be the monthly free allowance spread evenly across the month: daily ≈
 * monthly / 30. That way a full month of daily runs exactly fits the monthly
 * ceiling — 30 capped days == the monthly cap — while still draining the backlog
 * steadily, and a single day's run can NEVER blow the month.
 *
 * (Contrast the generic CLAUDE.md "daily = monthly/10" rule, which suits a
 * weekly/manual cadence where you want headroom for a few re-runs per day; a
 * *daily* schedule needs /30.) This math lives WITH the services because a
 * service's quota is the single source of truth for shared spend.
 */
export const DAILY_SPEND_DIVISOR = 30;

/** Default daily cap derived from a monthly cap (floored): monthly / 30. */
export function dailyFromMonthly(monthlyCap: number): number {
  return Math.floor(monthlyCap / DAILY_SPEND_DIVISOR);
}
