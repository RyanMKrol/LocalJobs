import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resources live alongside the job itself (src/workflows/missing-movies/data),
// never in a far-off top-level folder. Paths are resolved relative to this file.
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, 'data');

/**
 * Connectivity + paths for the Plex movie franchise-gap audit (T468 — split out
 * of `movie-recommendations` into its own workflow, mirroring
 * `missing-tv-seasons` vs `tv-recommendations`). Plex/TMDB connectivity itself
 * lives in the shared `src/core/plex-client.ts` (used by every Plex-touching
 * workflow — same Plex server, same TMDB account) — only the movie SECTION and
 * the data paths are workflow-specific. Tokens/host come from the gitignored
 * `.env`; only the env var NAMES are published (see `.env.example`). Library
 * data lives in the gitignored `data/` folder.
 *
 * This workflow's Plex snapshot is deliberately its OWN job with its OWN
 * `data/out/` (NOT shared with `movie-recommendations`'s `movie-snapshot`) — a
 * per-owner decision recorded in the T467 design record, mirroring how
 * `missing-tv-seasons`'s `plex-tv-snapshot` duplicates rather than shares
 * `tv-recommendations`'s snapshot. It also skips building a taste profile
 * (`taste-profile.json`) since this workflow's only consumer, `franchise-gaps`,
 * never reads one — only the recommendation branches in `movie-recommendations`
 * do.
 */
export const missingMoviesConfig = {
  dataDir,
  outDir: resolve(dataDir, 'out'),
  snapshotOut: resolve(dataDir, 'out', 'snapshot.json'),
  gapsOut: resolve(dataDir, 'out', 'franchise-gaps.json'),
  reportDir: resolve(dataDir, 'out', 'reports'),

  /** The movie library section to audit. Default 4 (the owner's "Movies"). */
  movieSection: process.env.PLEX_MOVIE_SECTION ?? '4',

  /** Plex host, read only for a log line — the real connectivity lives in the shared client. */
  host: process.env.PLEX_HOST ?? '',
};
