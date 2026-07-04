import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plexConfig } from '../missing-tv-seasons/config.js';

// Resources live alongside the job itself (src/workflows/plex-space-saver/data),
// never in a far-off top-level folder. Paths are resolved relative to this file.
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, 'data');

/**
 * Connectivity + paths for the Plex "space saver" size-breakdown audit. The Plex
 * host/token/machineId are SHARED with the other Plex workflows (same Plex
 * server) — reuse `plexConfig` rather than duplicating it. The movie/TV section
 * ids reuse the SAME env vars `PLEX_MOVIE_SECTION` / `PLEX_TV_SECTION` the
 * `movies` / `missing-tv-seasons` workflows already read, since they describe
 * the same two Plex library sections — no new env vars needed.
 */
export const plexSpaceSaverConfig = {
  dataDir,
  outDir: resolve(dataDir, 'out'),
  breakdownOut: resolve(dataDir, 'out', 'size-breakdown.json'),

  /** The movie library section to scan. Default 4 (the owner's "Movies", same as `movies`). */
  movieSection: process.env.PLEX_MOVIE_SECTION ?? '4',
  /** The TV library section to scan. Default 5 (the owner's "TV shows", same as `missing-tv-seasons`). */
  tvSection: process.env.PLEX_TV_SECTION ?? plexConfig.tvSection,
};
