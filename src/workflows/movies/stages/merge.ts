// Movie-domain thin wrapper over the shared recommender merge stage
// (src/core/recommender/merge.ts, T561). Keeps the exact same exported API
// (`runMerge`, `SearchMovieFn`, `MergeOpts`) so `merge.job.ts` and every
// existing merge test keeps working unchanged.
import { existsSync, readFileSync } from 'node:fs';
import type { JobContext } from '../../../core/types.js';
import { runMerge as coreRunMerge } from '../../../core/recommender/merge.js';
import type { MergeRunOpts, RunClaudeFn } from '../../../core/recommender/merge.js';
import { dayKey } from '../../../core/dates.js';
import { markWorkItem } from '../../../db/store.js';
import { moviesConfig } from '../config.js';
import { ensureDirs } from '../lib.js';
import { mapTmdbSearchResult, moviesDomain } from './branches.js';
import type { TmdbSearchResult } from '../types.js';

/** The DAG member (job) name the merge stage records its ledger row under. */
export const MERGE_JOB = 'rec-merge';

/** TMDB title search (injectable for tests). Returns the best match or null. */
export type SearchMovieFn = (title: string, year: number | null) => Promise<TmdbSearchResult | null>;

export interface MergeOpts {
  searchMovie?: SearchMovieFn;
  /** Inject the top-up source (tests). Defaults to fanning out over the branches. */
  topUp?: MergeRunOpts['topUp'];
  /** Inject the Claude runner the default top-up uses (tests). */
  runClaude?: RunClaudeFn;
  snapshotFile?: string;
  tasteFile?: string;
  historyFile?: string;
  recsDir?: string;
  recsOut?: string;
  now?: Date;
  // ── Threshold/target overrides (default from moviesConfig; tests pass these) ──
  minRating?: number;
  minVotes?: number;
  target?: number;
  genreCap?: number;
  topUpRounds?: number;
  /** Max concurrent branch re-prompts per top-up round (tests inject this to assert bounds). */
  topUpConcurrency?: number;
}

/**
 * Merge stage — pools all branches' raw suggestions, verifies+dedupes+quality-
 * filters them into the final balanced list, tops up when short of target.
 * Writes data/out/recommendations.json; appends data/out/recs-history.json. See
 * src/core/recommender/merge.ts for the full behaviour.
 */
export async function runMerge(ctx: JobContext, opts: MergeOpts = {}): Promise<void> {
  ensureDirs();
  const { searchMovie, ...rest } = opts;
  const search: MergeRunOpts['search'] = searchMovie
    ? async (title, year) => mapTmdbSearchResult(await searchMovie(title, year), title, year)
    : undefined;
  await coreRunMerge(ctx, moviesDomain, { ...rest, search });

  // One combined visibility row per run (T571), keyed by the run's ISO date so a
  // same-day manual re-run upserts it. Recorded only on a successful merge (a
  // TMDB-search-failure throw above skips it, correctly failing the run). Reads
  // the balanced count from the file the core merge just wrote.
  const recsOut = opts.recsOut ?? moviesConfig.recsOut;
  const now = opts.now ?? new Date();
  let balanced = 0;
  if (existsSync(recsOut)) {
    try {
      const file = JSON.parse(readFileSync(recsOut, 'utf8')) as { recommendations?: unknown[] };
      if (Array.isArray(file.recommendations)) balanced = file.recommendations.length;
    } catch {
      // Leave the count at 0 if unreadable — the row still records the stage ran.
    }
  }
  markWorkItem(MERGE_JOB, dayKey(now), 'success', {
    detail: { name: 'Balanced recommendations', balanced, path: recsOut, format: 'json' },
  });
}
