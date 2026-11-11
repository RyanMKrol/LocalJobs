// TV-domain thin wrapper over the shared recommender branch runner
// (src/core/recommender/branch.ts). `makeBranchJob` is what each per-branch
// `tv-rec-*.job.ts` file calls. The other exports (`runBranch`,
// `parseSuggestions`, `allHistoryTitles`, …) are the shared functions with the
// TV domain filled in, used by the tests.
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
import { tvArtifacts } from '../contracts.js';
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

/** Load the recommendation history titles (shows announced in earlier runs), up to `cap`. */
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
 * and write raw suggestions to data/out/recs/<branchId>.json. A rate or usage
 * limit, a junk reply, or a no-target branch writes an EMPTY suggestions file and
 * returns normally. Any other Claude failure (binary not found, a crash, a
 * timeout) throws, so the branch fails.
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
 * The stage for ONE TV recommender branch (each `tv-rec-*.job.ts` file is just
 * this, with its id). It reads the snapshot and the taste profile through its
 * input ports and commits its suggestions; the engine records both, and the
 * sample of shows the branch actually put in its prompt. `runOpts` is test-only:
 * it lets a test inject a mock `runClaude` and fixture paths.
 */
export function makeBranchJob(id: string, runOpts?: BranchRunOpts): JobDefinition {
  branchById(id); // throws on an unknown id
  return makeBranchStage(tvDomain, tvArtifacts, id, { before: ensureDirs, runOpts });
}
