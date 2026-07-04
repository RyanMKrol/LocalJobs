/**
 * "2026-W27" — the ISO-8601 week key. Shared across ALL THREE stock-digest
 * stages as the common lineage root (`root_key`): `stock-portfolio-snapshot`
 * records its one collapsed ledger row keyed by this, and both
 * `stock-sector-lookup` (per-ticker keys) and `stock-digest-build` (its own
 * week-keyed row) pass it as `rootKey` so the workflow-run Input → Output
 * panel joins all three stages to one shared root instead of three disjoint
 * key spaces.
 */
export function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO week: Thursday of this week determines the week-numbering year.
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/** "Week 27, 2026" — human-readable heading, derived from the same ISO week key. */
export function weekLabel(date: Date): string {
  const key = weekKey(date);
  const [year, w] = key.split('-W');
  return `Week ${Number(w)}, ${year}`;
}
