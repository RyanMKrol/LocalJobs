import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plexConfig } from '../missing-tv-seasons/config.js';

// Resources live alongside the job itself (src/workflows/plex-library-guard/data),
// never in a far-off top-level folder. Paths are resolved relative to this file.
import { resolveWorkflowDataDir } from '../../config.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolveWorkflowDataDir(resolve(here, 'data'));

/**
 * Connectivity + paths for the Plex library guard (per-file snapshot + deletion
 * alerts). Plex host/token/machineId are SHARED with the other Plex workflows
 * (same server): the shared client reads them itself. The movie/TV section ids
 * reuse the SAME env vars `PLEX_MOVIE_SECTION` / `PLEX_TV_SECTION` the other
 * Plex workflows already read, since they describe the same two library
 * sections. The only guard-specific env var is the drop threshold.
 */
export const plexLibraryGuardConfig = {
  dataDir,
  outDir: resolve(dataDir, 'out'),
  /**
   * The persisted baseline: the full per-file inventory as of the last
   * successful run. Only ever overwritten AFTER the alert path settles, so a
   * failed alert (or a suspected partial Plex read) never loses the last-good
   * inventory to diff against.
   */
  snapshotOut: resolve(dataDir, 'out', 'library-snapshot.json'),
  /** Small always-written per-run summary (what was found, what was alerted). */
  reportOut: resolve(dataDir, 'out', 'guard-report.json'),

  /** The movie library section to scan. Default 4 (the owner's "Movies", same as `movies`). */
  movieSection: process.env.PLEX_MOVIE_SECTION ?? '4',
  /** The TV library section to scan. Default 5 (the owner's "TV shows", same as `missing-tv-seasons`). */
  tvSection: process.env.PLEX_TV_SECTION ?? plexConfig.tvSection,

  /**
   * Shrink-alert threshold in GB. Default 0: ANY run-over-run decrease in the
   * library's total size alerts. Deliberately stricter than the old
   * plex-space-saver shrink guard's 1 GB buffer (which this workflow
   * supersedes): the guard exists to catch deletions while file-moving
   * workflows are being built, so paranoia is the point. Absolute GB, not a
   * percentage. Env-overridable via PLEX_GUARD_DROP_GB.
   */
  dropThresholdGb: Number(process.env.PLEX_GUARD_DROP_GB ?? '0'),
};
