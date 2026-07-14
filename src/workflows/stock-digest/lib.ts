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
import { readFileSync } from 'fs';

import type { NormalizedPosition } from '../../services/trading212.service.js';
import { weekKey } from '../../core/dates.js';
export { weekKey };

/** "Week 27, 2026" — human-readable heading, derived from the same ISO week key. */
export function weekLabel(date: Date): string {
  const key = weekKey(date);
  const [year, w] = key.split('-W');
  return `Week ${Number(w)}, ${year}`;
}

/**
 * Read a `NormalizedPosition[]` snapshot from a JSON path, tolerant of a
 * missing/empty/malformed file (returns `[]` in every failure case, and also
 * when the parsed JSON is not an array). The single shared definition (T564) —
 * previously duplicated verbatim in `stock-sector-lookup`, `stock-digest-build`,
 * and `stocks-sync`'s `stocks-watch`, which all read the same shared
 * `NormalizedPosition` snapshot shape and rely on the same missing/empty-file
 * tolerance. Both stock-digest stages and stocks-sync already share the
 * Trading212 service (where `NormalizedPosition` is defined), so this is a
 * portfolio-read concern common to both, not a workflow-specific one.
 */
export function readPortfolio(path: string): NormalizedPosition[] {
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as NormalizedPosition[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
