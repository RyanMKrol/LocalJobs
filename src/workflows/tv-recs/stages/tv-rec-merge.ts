// TV-domain thin wrapper over the shared recommender merge stage
// (src/core/recommender/merge.ts, T561). Keeps the exact same exported API
// (`runTvRecMerge`, `SearchTvFn`, `TmdbTvSearchResult`, `MergeOpts`) so
// `tv-rec-merge.job.ts` and every existing merge test keeps working unchanged.
import { existsSync, readFileSync } from 'node:fs';
import type { JobContext } from '../../../core/types.js';
import { runMerge as coreRunMerge } from '../../../core/recommender/merge.js';
import type { MergeRunOpts, RunClaudeFn } from '../../../core/recommender/merge.js';
import { dayKey } from '../../../core/dates.js';
import { markWorkItem } from '../../../db/store.js';
import { tvRecsConfig } from '../config.js';
import { ensureDirs } from '../lib.js';
import { mapTmdbTvSearchResult, tvDomain } from './branches.js';
import type { TmdbTvSearchResponse, TmdbTvSearchResult } from './branches.js';

export type { TmdbTvSearchResponse, TmdbTvSearchResult };

/** The DAG member (job) name the merge stage records its ledger row under. */
export const TV_MERGE_JOB = 'tv-rec-merge';

/** TMDB TV title search (injectable for tests). Returns the best match or null. */
export type SearchTvFn = (title: string, year: number | null) => Promise<TmdbTvSearchResult | null>;

export interface MergeOpts {
  searchTv?: SearchTvFn;
  topUp?: MergeRunOpts['topUp'];
  runClaude?: RunClaudeFn;
  snapshotFile?: string;
  tasteFile?: string;
  historyFile?: string;
  recsDir?: string;
  recsOut?: string;
  now?: Date;
  minRating?: number;
  minVotes?: number;
  target?: number;
  genreCap?: number;
  topUpRounds?: number;
  topUpConcurrency?: number;
}

/**
 * Merge stage — pools all branches' raw suggestions, TMDB-verifies+dedupes+
 * quality-filters them into the final balanced list, tops up when short of
 * target. Writes data/out/recommendations.json. See
 * src/core/recommender/merge.ts for the full behaviour.
 */
export async function runTvRecMerge(ctx: JobContext, opts: MergeOpts = {}): Promise<void> {
  ensureDirs();
  const { searchTv, ...rest } = opts;
  const search: MergeRunOpts['search'] = searchTv
    ? async (title, year) => mapTmdbTvSearchResult(await searchTv(title, year), title, year)
    : undefined;
  await coreRunMerge(ctx, tvDomain, { ...rest, search });

  // One combined visibility row per run (T571), keyed by the run's ISO date so a
  // same-day manual re-run upserts it. Recorded only on a successful merge (a
  // TMDB-search-failure throw above skips it, correctly failing the run). Reads
  // the balanced count from the file the core merge just wrote.
  const recsOut = opts.recsOut ?? tvRecsConfig.recsOut;
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
  markWorkItem(TV_MERGE_JOB, dayKey(now), 'success', {
    detail: { name: 'Balanced recommendations', balanced, path: recsOut, format: 'json' },
  });
}
