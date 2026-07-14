// Movie-domain thin wrapper over the shared recommender branch runner
// (src/core/recommender/branch.ts, T561). Keeps the exact same exported API
// (`runBranch`, `makeBranchJob`, `parseSuggestions`, `allHistoryTitles`, …) so
// every existing call site (the per-branch `*.job.ts` files, `merge.ts`,
// `recommend.test.ts`) keeps working unchanged.
import type { JobContext, JobDefinition } from '../../../core/types.js';
import {
  allHistoryTitles as coreAllHistoryTitles,
  collectBranchSuggestions as coreCollectBranchSuggestions,
  ignoredSuggestionTitles as coreIgnoredSuggestionTitles,
  makeBranchJob as coreMakeBranchJob,
  parseSuggestions,
  recentTitles as coreRecentTitles,
  runBranch as coreRunBranch,
} from '../../../core/recommender/branch.js';
import type { BranchRunOpts, RunClaudeFn } from '../../../core/recommender/branch.js';
import { branchSuggestionsContract, movieSnapshotContract } from '../contracts.js';
import { ensureDirs } from '../lib.js';
import { RECS_JOB } from '../recs.js';
import { branchById, moviesDomain } from './branches.js';
import type { BranchContext, BranchSpec } from './branches.js';

export { parseSuggestions };
export type { RunClaudeFn };
export type BranchOpts = BranchRunOpts;

export function recentTitles(historyFile: string, window: number): string[] {
  return coreRecentTitles(historyFile, window);
}

/**
 * Load ALL recommendation history titles up to `cap` (T183) — the full already-
 * recommended/ignored set to pass to branch prompts so they avoid re-suggesting
 * across months, not just the recent window. Bounded at `cap` to keep prompts
 * token-sensible. Exported so merge.ts can reuse it in top-up rounds.
 */
export function allHistoryTitles(historyFile: string, cap: number): string[] {
  return coreAllHistoryTitles(historyFile, cap);
}

/** Titles of currently owner-IGNORED recommendations (T404). */
export function ignoredSuggestionTitles(jobName: string = RECS_JOB): string[] {
  return coreIgnoredSuggestionTitles(jobName);
}

/**
 * Run ONE recommender branch: build its prompt from the taste profile + a
 * stratified library sample, ask Claude for ~5 diverse un-owned films, and write
 * its raw suggestions to data/out/recs/<branchId>.json. Resilient by design — a
 * Claude error, rate-limit, junk/no-JSON reply, or a branch with nothing to ask
 * writes an EMPTY suggestions file and returns normally (the run continues; the
 * merge stage simply has fewer candidates). It NEVER throws on LLM trouble.
 */
export async function runBranch(ctx: JobContext, spec: BranchSpec, opts: BranchRunOpts = {}): Promise<void> {
  ensureDirs();
  await coreRunBranch(ctx, moviesDomain, spec, opts);
}

/**
 * Run ONE branch IN-MEMORY for the merge top-up loop (T162): build its prompt
 * (with the top-up `exclude` list folded in), call Claude, parse → raw
 * suggestions. No file I/O. Resilient: a null prompt (no targets), a Claude
 * error/rate-limit, or unparseable output all yield `[]` so the loop continues.
 */
export async function collectBranchSuggestions(
  spec: BranchSpec,
  ctx: BranchContext,
  run: RunClaudeFn,
  model: string,
) {
  return coreCollectBranchSuggestions(spec, ctx, run, model);
}

/**
 * Build the thin JobDefinition for ONE recommender branch (its `*.job.ts` file
 * just calls this with its id). Each branch depends on movie-snapshot and is a
 * member of the `movies` workflow; it produces no gated artifact (an empty branch
 * is legitimate, so a gate would wrongly fail the run).
 */
export function makeBranchJob(id: string): JobDefinition {
  const spec = branchById(id);
  return coreMakeBranchJob(moviesDomain, id, {
    consumes: [movieSnapshotContract()],
    produces: [branchSuggestionsContract(spec.id)],
  });
}
