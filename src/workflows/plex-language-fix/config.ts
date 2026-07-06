import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plexConfig } from '../missing-tv-seasons/config.js';

// Resources live alongside the job itself (src/workflows/plex-language-fix/data),
// never in a far-off top-level folder. Paths are resolved relative to this file.
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, 'data');

/**
 * Connectivity + paths for the Plex per-title original-language default audit.
 * Plex/TMDB connectivity itself (host, token, machineId, timeouts) lives in the
 * shared, self-contained `src/core/plex-client.ts` — this config only keeps the
 * library section ids. The movie/TV sections reuse the SAME `PLEX_MOVIE_SECTION` /
 * `PLEX_TV_SECTION` env vars every other Plex-touching workflow already reads
 * (no new env vars for those two).
 */
export const plexLanguageFixConfig = {
  dataDir,
  outDir: resolve(dataDir, 'out'),
  scanOut: resolve(dataDir, 'out', 'language-scan.json'),

  /** The movie library section to scan. Default 4 (the owner's "Movies"). */
  movieSection: process.env.PLEX_MOVIE_SECTION ?? '4',
  /** The TV library section to scan. Default 5 (the owner's "TV shows"). */
  tvSection: process.env.PLEX_TV_SECTION ?? plexConfig.tvSection,
  /**
   * Optional third, lower-confidence library section (e.g. a "Downloadable"/
   * personal-rip section) — unset by default, meaning it is EXCLUDED from the
   * scan. Set to a Plex section key to opt it in. Deliberately opt-in, not
   * opt-out: the owner chose to exclude this section by default.
   */
  downloadableSection: process.env.PLEX_DOWNLOADABLE_SECTION,
};
