// TV-domain thin wrapper over the shared recommender branch runner
// (src/core/recommender/branch.ts, T561). Keeps the exact same exported API
// (`runBranch`, `makeBranchJob`, `parseSuggestions`, `allHistoryTitles`, …) so
// every existing call site (the per-branch `*.job.ts` files, `tv-rec-merge.ts`)
// keeps working unchanged.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { dayKey } from '../../../core/dates.js';
import { markWorkItem } from '../../../db/store.js';
import { tvRecsConfig } from '../config.js';
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
  await coreRunBranch(ctx, tvDomain, spec, {
    ...opts,
    onBranchWritten: (branchId, o) => {
      recordBranchLedgerRow(branchId, o);
      opts.onBranchWritten?.(branchId, o);
    },
  });
}

/**
 * Record ONE combined visibility row per run for this branch (T571) — keyed by
 * the run's ISO date so a same-day manual re-run upserts the same row. The branch
 * runs as its own DAG member (job name = branch id), so the run page's
 * Input/Output panel shows the branch's suggestion count + its output file.
 * Reads the count from the file the core runner just wrote (empty on any LLM
 * trouble — a legitimate zero, still worth showing).
 */
function recordBranchLedgerRow(branchId: string, opts: BranchRunOpts): void {
  const recsDir = opts.recsDir ?? tvRecsConfig.recsDir;
  const now = opts.now ?? new Date();
  const path = join(recsDir, `${branchId}.json`);
  let suggestions = 0;
  if (existsSync(path)) {
    try {
      const file = JSON.parse(readFileSync(path, 'utf8')) as { suggestions?: unknown[] };
      if (Array.isArray(file.suggestions)) suggestions = file.suggestions.length;
    } catch {
      // Leave the count at 0 if the file is unreadable — the row still records the branch ran.
    }
  }
  markWorkItem(branchId, dayKey(now), 'success', {
    detail: { name: `${branchId} suggestions`, suggestions, path },
  });
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
 * Build the thin JobDefinition wrapper for ONE TV recommender branch. `runOpts`
 * is test-only — it lets a test inject a mock `runClaude` + fixture paths to
 * drive the returned `run(ctx)` end-to-end without a live Claude call; real
 * `*.job.ts` call sites never pass it.
 */
export function makeBranchJob(id: string, runOpts?: BranchRunOpts): JobDefinition {
  const spec = branchById(id);
  return coreMakeBranchJob(tvDomain, id, {
    consumes: [tvSnapshotContract()],
    produces: [tvBranchSuggestionsContract(spec.id)],
  }, {
    onBranchWritten: (branchId, opts) => recordBranchLedgerRow(branchId, opts),
    runOpts,
  });
}
