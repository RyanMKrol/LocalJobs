/**
 * Shared date-key helpers used to derive a stable `work_items` ledger key
 * (and `root_key`) from a run's "now" — one calendar-day or ISO-week bucket
 * per key, so a re-run within the same bucket collapses onto the same row
 * instead of creating a new one.
 */

/** "2026-W27" — the ISO-8601 week key: Thursday of the week determines the numbering year. */
export function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/** "2026-07-04" — the UTC calendar-day key. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
