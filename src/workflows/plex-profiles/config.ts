import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resources live alongside the job itself (src/workflows/plex-profiles/data),
// never in a far-off top-level folder. Paths are resolved relative to this file.
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, 'data');

/**
 * Connectivity + paths for the plex-profiles per-title markdown builder. Plex
 * host/token/machineId connectivity is shared (`src/core/plex-client.ts`'s
 * `plexGet`/`resolvePlexHost`), and the movie/TV section ids reuse the SAME
 * `PLEX_MOVIE_SECTION` / `PLEX_TV_SECTION` env vars the `movies` /
 * `missing-tv-seasons` / `plex-space-saver` workflows already read — no
 * duplicated connectivity config.
 */
export const plexProfilesConfig = {
  dataDir,
  outDir: resolve(dataDir, 'out'),
  moviesOutDir: resolve(dataDir, 'out', 'movies'),
  showsOutDir: resolve(dataDir, 'out', 'shows'),

  /** The movie library section to scan. Default 4 (the owner's "Movies"). */
  movieSection: process.env.PLEX_MOVIE_SECTION ?? '4',
  /** The TV library section to scan. Default 5 (the owner's "TV shows"). */
  tvSection: process.env.PLEX_TV_SECTION ?? '5',

  /**
   * Max titles (re)built in a single run (0 = unlimited), mirroring the
   * `PLACES_ENRICH_RUN_LIMIT` / `PERFUMES_RUN_LIMIT` convention — caps a large
   * first-run backlog (the owner's whole library) so the job's `timeoutMs`
   * isn't blown; the next run resumes with whatever wasn't reached.
   */
  runLimit: Number(process.env.PLEX_PROFILES_RUN_LIMIT ?? 0),
};
