// TV-domain thin wrapper over the shared recommender branch runner
// (src/core/recommender/branch.ts, T561). Keeps the exact same exported API
// (`runBranch`, `makeBranchJob`, `parseSuggestions`, `allHistoryTitles`, …) so
// every existing call site (the per-branch `*.job.ts` files, `tv-rec-merge.ts`)
// keeps working unchanged.
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
import { tvBranchSuggestionsContract, tvSnapshotContract } from '../contracts.js';
import { ensureDirs } from '../lib.js';
import { RECS_JOB } from '../recs.js';
import { branchById, tvDomain } from './branches.js';
import type { BranchContext, BranchSpec } from './branches.js';

export { parseSuggestions };
export type { RunClaudeFn };
export type BranchOpts = BranchRunOpts;

export function recentTitles(historyFile: string, window: number): string[] {
  return coreRecentTitles(historyFile, window);
}

/** Load ALL recommendation history titles up to `cap` (full already-recommended/ignored set). */
export function allHistoryTitles(historyFile: string, cap: number): string[] {
  return coreAllHistoryTitles(historyFile, cap);
}

/**
 * Titles of currently owner-IGNORED recommendations (T404) — formatted identically
 * to {@link allHistoryTitles}'s `"Title (Year)"` / bare `"Title"` output, so it can
 * be concatenated straight into the same exclude list.
 */
export function ignoredSuggestionTitles(jobName: string = RECS_JOB): string[] {
  return coreIgnoredSuggestionTitles(jobName);
}

/**
 * Run ONE TV recommender branch: build its prompt from the taste profile + a
 * stratified library sample, call Claude for diverse un-owned show recommendations,
 * and write raw suggestions to data/out/recs/<branchId>.json. Resilient — a
 * Claude error, rate-limit, junk reply, or no-target branch writes an EMPTY
 * suggestions file and returns normally.
 *
 * Every Claude call goes through `runClaude` from `src/services/claude.ts`, which
 * routes via `callService('claude-cli', …)` — the rate-limit + monthly quota are
 * enforced globally. Never call the CLI directly.
 */
export async function runBranch(ctx: JobContext, spec: BranchSpec, opts: BranchRunOpts = {}): Promise<void> {
  ensureDirs();
  await coreRunBranch(ctx, tvDomain, spec, opts);
}

/**
 * Run ONE branch IN-MEMORY for the merge top-up loop: build its prompt (with the
 * top-up `exclude` list), call Claude, parse → raw suggestions. No file I/O.
 * Resilient: null prompt, Claude error, or unparseable output all yield `[]`.
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
 * Build the thin JobDefinition wrapper for ONE TV recommender branch.
 * Each branch's *.job.ts calls this with its id.
 */
export function makeBranchJob(id: string): JobDefinition {
  const spec = branchById(id);
  return coreMakeBranchJob(tvDomain, id, {
    consumes: [tvSnapshotContract()],
    produces: [tvBranchSuggestionsContract(spec.id)],
  });
}
