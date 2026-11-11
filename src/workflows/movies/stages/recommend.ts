// Movie-domain thin wrapper over the shared recommender branch runner
// (src/core/recommender/branch.ts). `makeBranchJob` is what each per-branch
// `rec-*.job.ts` file calls. The other exports (`runBranch`, `parseSuggestions`,
// `allHistoryTitles`, …) are the shared functions with the movie domain filled
// in, used by the tests.
import type { JobContext, JobDefinition } from '../../../core/types.js';
import {
  allHistoryTitles as coreAllHistoryTitles,
  collectBranchSuggestions as coreCollectBranchSuggestions,
  ignoredSuggestionTitles as coreIgnoredSuggestionTitles,
  parseSuggestions,
  recentTitles as coreRecentTitles,
  runBranch as coreRunBranch,
} from '../../../core/recommender/branch.js';
import type { BranchRunOpts, RunClaudeFn } from '../../../core/recommender/branch.js';
import { makeBranchStage } from '../../../core/recommender/stages.js';
import { movieArtifacts } from '../contracts.js';
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
 * Load the recommendation history titles, up to `cap` (T183): the titles
 * announced in earlier runs, passed to branch prompts so they avoid suggesting
 * them again across months, not just the recent window. Bounded at `cap` to keep
 * prompts a sensible size.
 */
export function allHistoryTitles(historyFile: string, cap: number): string[] {
  return coreAllHistoryTitles(historyFile, cap);
}

/** Titles of currently owner-IGNORED recommendations (T404). */
export function ignoredSuggestionTitles(jobName: string = RECS_JOB): string[] {
  return coreIgnoredSuggestionTitles(jobName);
}

/**
 * Run ONE recommender branch: build its prompt from the taste profile + the
 * owned films its lens selects, ask Claude for a batch of un-owned films
 * (`MOVIES_RECS_PER_BRANCH_ASK`, default 9), and write its raw suggestions to
 * data/out/recs/<branchId>.json. A rate or usage limit, a junk/no-JSON reply, or
 * a branch with nothing to ask writes an EMPTY suggestions file and returns
 * normally (the merge stage has fewer candidates). Any other Claude failure
 * (binary not found, a crash, a timeout) throws, so the branch fails.
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
 * The stage for ONE movie recommender branch (each `rec-*.job.ts` file is just
 * this, with its id). It reads the snapshot and the taste profile through its
 * input ports and commits its suggestions; the engine records both, and the
 * sample of films the branch actually put in its prompt. `runOpts` is test-only:
 * it lets a test inject a mock `runClaude` and fixture paths.
 */
export function makeBranchJob(id: string, runOpts?: BranchRunOpts): JobDefinition {
  branchById(id); // throws on an unknown id
  return makeBranchStage(moviesDomain, movieArtifacts, id, { before: ensureDirs, runOpts });
}
