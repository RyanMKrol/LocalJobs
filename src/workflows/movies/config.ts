import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingMoviesConfig } from '../missing-movies/config.js';

// Resources live alongside the job itself (src/workflows/movies/data), never in a
// far-off top-level folder. Paths are resolved relative to this file.
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, 'data');

/**
 * Connectivity + paths for the movie-recommendations workflow (taste-based
 * recommendations only — the franchise-gap audit lives in the sibling
 * `missing-movies` workflow, T468). Plex/TMDB connectivity itself lives in the
 * shared `src/core/plex-client.ts` (used by every Plex-touching workflow — same
 * Plex server, same TMDB account) — only the movie SECTION and the data paths
 * are movie-specific. Tokens/host come from the gitignored `.env`; only the env
 * var NAMES are published (see `.env.example`). Library data lives in the
 * gitignored `data/` folder.
 */
export const moviesConfig = {
  dataDir,
  outDir: resolve(dataDir, 'out'),
  snapshotOut: resolve(dataDir, 'out', 'snapshot.json'),
  tasteOut: resolve(dataDir, 'out', 'taste-profile.json'),
  reportDir: resolve(dataDir, 'out', 'reports'),
  /**
   * T468 compat re-export: `franchise-gaps.json` is now written by the
   * sibling `missing-movies` workflow's `franchise-gaps` job, not this one —
   * this alias just points `src/api/server.ts`'s existing
   * `moviesConfig.gapsOut` read (its `GET /api/movie-gaps` endpoint) at the
   * REAL current location, since `src/api/server.ts` was out of scope for the
   * T468 build task. A future task with `src/api/server.ts` in scope should
   * read `missingMoviesConfig.gapsOut` directly there and delete this alias.
   */
  gapsOut: missingMoviesConfig.gapsOut,

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

  /** Plex host, read only for a log line — the real connectivity lives in the shared client. */
  host: process.env.PLEX_HOST ?? '',
};
