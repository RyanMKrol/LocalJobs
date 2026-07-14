/**
 * "2026-W27" — the ISO-8601 week key. Shared across ALL THREE stock-digest
 * stages as the common lineage root (`root_key`): `stock-portfolio-snapshot`
 * records its one collapsed ledger row keyed by this, and both
 * `stock-sector-lookup` (per-ticker keys) and `stock-digest-build` (its own
 * week-keyed row) pass it as `rootKey` so the workflow-run Input → Output
 * panel joins all three stages to one shared root instead of three disjoint
 * key spaces. Re-exported from `src/core/dates.ts` (the single shared
 * definition) so every existing `from '../lib.js'` import keeps resolving.
 */
import { weekKey } from '../../core/dates.js';
export { weekKey };

/** "Week 27, 2026" — human-readable heading, derived from the same ISO week key. */
export function weekLabel(date: Date): string {
  const key = weekKey(date);
  const [year, w] = key.split('-W');
  return `Week ${Number(w)}, ${year}`;
}
