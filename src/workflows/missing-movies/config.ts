import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resources live alongside the job itself (src/workflows/missing-movies/data), never in a
// far-off top-level folder. Paths are resolved relative to this file.
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, 'data');

/**
 * Connectivity + paths for the Plex movie franchise-gap audit — its OWN Plex
 * snapshot, separate from `movie-recommendations`'s (mirrors `plex-tv-snapshot`
 * vs the TV recommender's own snapshot). Plex/TMDB connectivity itself lives in
 * the shared `src/core/plex-client.ts` (used by every Plex-touching workflow —
 * same Plex server, same TMDB account) — only the movie SECTION and the data
 * paths are workflow-specific. Tokens/host come from the gitignored `.env`; only
 * the env var NAMES are published (see `.env.example`). Library data lives in
 * the gitignored `data/` folder.
 */
export const missingMoviesConfig = {
  dataDir,
  outDir: resolve(dataDir, 'out'),
  snapshotOut: resolve(dataDir, 'out', 'snapshot.json'),
  gapsOut: resolve(dataDir, 'out', 'franchise-gaps.json'),
  reportDir: resolve(dataDir, 'out', 'reports'),

  /** The movie library section to audit. Default 4 (the owner's "Movies"), same
   *  section movie-recommendations audits — deliberately shared, not a separate env var. */
  movieSection: process.env.PLEX_MOVIE_SECTION ?? '4',

  /** Plex host, read only for a log line — the real connectivity lives in the shared client. */
  host: process.env.PLEX_HOST ?? '',
};
