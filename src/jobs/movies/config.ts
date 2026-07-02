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

  // ── Recommendation layer (T146) ──
  /** Per-branch raw-suggestion files live here (one JSON per branch). */
  recsDir: resolve(dataDir, 'out', 'recs'),
  /** The merge stage's verified/deduped/balanced recommendation list. */
  recsOut: resolve(dataDir, 'out', 'recommendations.json'),
  /** Append-only recommended-film history, fed back into branch prompts. */
  recsHistoryOut: resolve(dataDir, 'out', 'recs-history.json'),
  /** The (free) Claude model the recommender branches use. */
  recsModel: process.env.MOVIES_RECS_MODEL ?? 'claude-sonnet-5',
  /** Owned-library sample size each branch shows Claude (stratified). */
  recsSampleSize: Number(process.env.MOVIES_RECS_SAMPLE ?? 50),
  /** How many films each branch is asked for (headroom after filtering, T162). */
  recsPerBranchAsk: Number(process.env.MOVIES_RECS_PER_BRANCH_ASK ?? 9),
  /** Target size of the final balanced recommendation list (≥15, T162). */
  recsTarget: Number(process.env.MOVIES_RECS_TARGET ?? 15),
  /** Max recommendations per genre in the final balanced output. */
  recsGenreCap: Number(process.env.MOVIES_RECS_GENRE_CAP ?? 3),
  /** Quality floor: minimum TMDB vote_average to keep a recommendation (T162). */
  recsMinRating: Number(process.env.MOVIES_RECS_MIN_RATING ?? 7.0),
  /** Quality floor: minimum TMDB vote_count so the rating is meaningful (T162). */
  recsMinVotes: Number(process.env.MOVIES_RECS_MIN_VOTES ?? 50),
  /** Bounded number of merge top-up rounds when under target (T162). */
  recsTopUpRounds: Number(process.env.MOVIES_RECS_TOPUP_ROUNDS ?? 3),
  /** Max concurrent branch re-prompts per top-up round (T182). Each branch is a
   *  Claude CLI subprocess — cap keeps CPU/memory manageable on the Mac Mini. */
  recsTopUpConcurrency: Number(process.env.MOVIES_RECS_TOPUP_CONCURRENCY ?? 4),
  /** How many recent recommendations to feed back into branch prompts. */
  recsRecentWindow: Number(process.env.MOVIES_RECS_RECENT_WINDOW ?? 40),
  /** Max number of history titles passed as "already-suggested" context to branch prompts (bounded). */
  recsHistoryContext: Number(process.env.MOVIES_RECS_HISTORY_CONTEXT ?? 200),

  /** The movie library section to audit. Default 4 (the owner's "Movies"). */
  movieSection: process.env.PLEX_MOVIE_SECTION ?? '4',

  // ── Shared connectivity (reused from the TV workflow's plexConfig) ──
  get host() { return plexConfig.host; },
  get token() { return plexConfig.token; },
  get tmdbToken() { return plexConfig.tmdbToken; },
  get requestTimeoutMs() { return plexConfig.requestTimeoutMs; },
};
