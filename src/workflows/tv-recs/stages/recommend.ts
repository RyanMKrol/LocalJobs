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
    onBranchWritten: (branchId, o, sampledItems) => {
      recordBranchLedgerRow(branchId, o, sampledItems);
      opts.onBranchWritten?.(branchId, o, sampledItems);
    },
  });
}

/**
 * Record ONE ledger row PER SUGGESTION for this branch (T600) — each row's key is
 * a branch-local, stable id scoped by the run's ISO date (so a same-day manual
 * re-run upserts the same set), and each row's detail carries the suggestion's
 * own fields (title, year, reason, lens) per CLAUDE.md's "every stage's success
 * detail must describe what THAT STAGE produced" convention.
 * The branch runs as its own DAG member (job name = branch id), so the run page's
 * Input/Output panel shows each suggestion as a separate row.
 * On error/skip cases (no targets, Claude failure, unparseable output), records
 * zero rows rather than crashing — these are legitimate, resilient outcomes.
 */
function recordBranchLedgerRow(branchId: string, opts: BranchRunOpts, sampledItems?: unknown[]): void {
  const recsDir = opts.recsDir ?? tvRecsConfig.recsDir;
  const now = opts.now ?? new Date();
  const path = join(recsDir, `${branchId}.json`);
  if (existsSync(path)) {
    try {
      const file = JSON.parse(readFileSync(path, 'utf8')) as { suggestions?: unknown[] };
      if (Array.isArray(file.suggestions)) {
        // Record ONE row per suggestion
        for (let index = 0; index < file.suggestions.length; index++) {
          const s = file.suggestions[index];
          if (!s || typeof s !== 'object') continue;
          const suggestion = s as { title?: unknown; year?: unknown; reason?: unknown; lens?: unknown };
          const title = typeof suggestion.title === 'string' ? suggestion.title.trim() : '';
          if (!title) continue; // Skip malformed suggestions
          const itemKey = `${dayKey(now)}::${index}`;
          markWorkItem(branchId, itemKey, 'success', {
            detail: {
              title,
              year: typeof suggestion.year === 'number' ? suggestion.year : null,
              reason: typeof suggestion.reason === 'string' ? suggestion.reason.trim() : '',
              lens: typeof suggestion.lens === 'string' ? suggestion.lens : 'unknown',
            },
          });
        }
      }
    } catch {
      // Leave zero rows if the file is unreadable — a legitimate skip outcome
    }
  }
  // If the file doesn't exist or has no suggestions, zero rows are recorded
  recordInputSampleRows(branchId, sampledItems, now);
}

/**
 * Record the EXACT owned items (T615) `spec.build()` reported it put into this
 * branch's prompt — one `work_items` row per item, keyed
 * `<dayKey>::input::<index>` (a distinct keyspace from the `<dayKey>::<index>`
 * per-suggestion output rows above) with `detail.kind: 'input-sample'` — see
 * `movies/stages/recommend.ts`'s twin for the full rationale (this workflow
 * mirrors it exactly). No-op when `sampledItems` is absent (the branch's
 * `build()` returned null — nothing was ever selected).
 */
function recordInputSampleRows(branchId: string, sampledItems: unknown[] | undefined, now: Date): void {
  if (!Array.isArray(sampledItems)) return;
  for (let index = 0; index < sampledItems.length; index++) {
    const raw = sampledItems[index];
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as { ratingKey?: unknown; title?: unknown; year?: unknown };
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if (!title) continue;
    const id = typeof item.ratingKey === 'string' ? item.ratingKey : String(index);
    const itemKey = `${dayKey(now)}::input::${index}`;
    markWorkItem(branchId, itemKey, 'success', {
      detail: {
        kind: 'input-sample',
        id,
        title,
        year: typeof item.year === 'number' ? item.year : null,
      },
    });
  }
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
    onBranchWritten: (branchId, opts, sampledItems) => recordBranchLedgerRow(branchId, opts, sampledItems),
    runOpts,
  });
}
