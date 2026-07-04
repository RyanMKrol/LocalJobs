import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, 'data');

/**
 * Connectivity + paths for the Plex TV recommendations workflow. Plex/TMDB
 * connectivity itself lives in the shared `src/core/plex-client.ts` (used by
 * every Plex-touching workflow) — only the TV section and data paths are
 * tv-recs-specific.
 */
export const tvRecsConfig = {
  dataDir,
  outDir: resolve(dataDir, 'out'),
  snapshotOut: resolve(dataDir, 'out', 'snapshot.json'),
  tasteOut: resolve(dataDir, 'out', 'taste-profile.json'),
  recsDir: resolve(dataDir, 'out', 'recs'),
  recsOut: resolve(dataDir, 'out', 'recommendations.json'),
  recsHistoryOut: resolve(dataDir, 'out', 'recs-history.json'),
  reportDir: resolve(dataDir, 'out', 'reports'),

  /** The TV library section to read. Default 5 (the owner's "TV Shows"). */
  tvSection: process.env.PLEX_TV_SECTION ?? '5',

  /** The Claude model the recommender branches use. */
  recsModel: process.env.TV_RECS_MODEL ?? 'claude-sonnet-4-6',
  /** Owned-library sample size shown to each branch. */
  recsSampleSize: Number(process.env.TV_RECS_SAMPLE ?? 40),
  /** Suggestions asked from each branch (headroom before dedup/quality filter). */
  recsPerBranchAsk: Number(process.env.TV_RECS_PER_BRANCH_ASK ?? 9),
  /** Target size of the final balanced recommendation list. */
  recsTarget: Number(process.env.TV_RECS_TARGET ?? 15),
  /** Max recommendations per genre in the final balanced output. */
  recsGenreCap: Number(process.env.TV_RECS_GENRE_CAP ?? 3),
  /** Minimum TMDB vote_average to keep a recommendation. */
  recsMinRating: Number(process.env.TV_RECS_MIN_RATING ?? 7.0),
  /** Minimum TMDB vote_count so the rating is meaningful. */
  recsMinVotes: Number(process.env.TV_RECS_MIN_VOTES ?? 50),
  /** Bounded number of merge top-up rounds when under target. */
  recsTopUpRounds: Number(process.env.TV_RECS_TOPUP_ROUNDS ?? 3),
  /** Max concurrent branch re-prompts per top-up round. */
  recsTopUpConcurrency: Number(process.env.TV_RECS_TOPUP_CONCURRENCY ?? 4),
  /** Recent recommendation window fed back into branch prompts. */
  recsRecentWindow: Number(process.env.TV_RECS_RECENT_WINDOW ?? 40),
  /** Max history titles passed as "already suggested" context. */
  recsHistoryContext: Number(process.env.TV_RECS_HISTORY_CONTEXT ?? 200),

  /** Plex host, read only for a log line — the real connectivity lives in the shared client. */
  host: process.env.PLEX_HOST ?? '',
};
