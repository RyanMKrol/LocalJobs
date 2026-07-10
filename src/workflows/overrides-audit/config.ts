import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resources live alongside the job itself (src/workflows/overrides-audit/data),
// never in a far-off top-level folder. Paths are resolved relative to this file.
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, 'data');

/** Paths + threshold for the dashboard-override staleness audit. */
export const overridesAuditConfig = {
  dataDir,
  outDir: resolve(dataDir, 'out'),
  reportOut: resolve(dataDir, 'out', 'stale-overrides.json'),

  /** An override live+unchanged this long or more is a candidate to fold into code (T475). */
  minAgeMs: 14 * 24 * 60 * 60 * 1000,
};
