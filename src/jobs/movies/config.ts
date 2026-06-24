import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plexConfig } from '../plex/config.js';

// Resources live alongside the job itself (src/jobs/movies/data), never in a
// far-off top-level folder. Paths are resolved relative to this file.
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, 'data');

/**
 * Connectivity + paths for the Plex movie franchise-gap audit. The Plex host +
 * token and the TMDB Bearer token are SHARED with the TV workflow (same Plex
 * server, same TMDB account), so we reuse `plexConfig` for connectivity rather
 * than duplicating it — only the movie SECTION and the data paths are
 * movie-specific. Tokens/host come from the gitignored `.env`; only the env var
 * NAMES are published (see `.env.example`). Library data lives in the gitignored
 * `data/` folder.
 */
export const moviesConfig = {
  dataDir,
  outDir: resolve(dataDir, 'out'),
  snapshotOut: resolve(dataDir, 'out', 'snapshot.json'),
  tasteOut: resolve(dataDir, 'out', 'taste-profile.json'),
  gapsOut: resolve(dataDir, 'out', 'franchise-gaps.json'),
  reportDir: resolve(dataDir, 'out', 'reports'),

  /** The movie library section to audit. Default 4 (the owner's "Movies"). */
  movieSection: process.env.PLEX_MOVIE_SECTION ?? '4',

  // ── Shared connectivity (reused from the TV workflow's plexConfig) ──
  get host() { return plexConfig.host; },
  get token() { return plexConfig.token; },
  get tmdbToken() { return plexConfig.tmdbToken; },
  get requestTimeoutMs() { return plexConfig.requestTimeoutMs; },
};
