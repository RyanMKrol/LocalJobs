import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resources live alongside the job itself (src/workflows/missing-tv-seasons/data), never in a
// far-off top-level folder. Paths are resolved relative to this file.
import { resolveWorkflowDataDir } from '../../config.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolveWorkflowDataDir(resolve(here, 'data'));

/**
 * Paths for the Plex new-seasons audit. Plex/TMDB connectivity itself (host,
 * token, machineId, requestTimeoutMs, tmdbToken) lives in the shared, self-contained
 * `src/core/plex-client.ts` — this config only keeps `host` (for a log line) and the
 * workflow-specific TV section. The library data lives in the gitignored `data/` folder.
 */
export const plexConfig = {
  dataDir,
  outDir: resolve(dataDir, 'out'),
  snapshotOut: resolve(dataDir, 'out', 'snapshot.json'),
  missingOut: resolve(dataDir, 'out', 'missing-seasons.json'),
  reportDir: resolve(dataDir, 'out', 'reports'),

  /** Plex host, read only for a log line — the real connectivity lives in the shared client. */
  host: process.env.PLEX_HOST ?? '',
  /** The TV library section to audit. Default 5 (the owner's "TV shows"). */
  tvSection: process.env.PLEX_TV_SECTION ?? '5',
};
