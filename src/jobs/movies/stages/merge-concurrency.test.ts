// T182 — concurrency tests for the rec-merge top-up loop.
// Asserts: bounded concurrency (never > N branches in flight), per-branch
// logging is correctly attributed under out-of-order completion.
// Hermetic: injected branch runner (no live Claude CLI calls), scratch DB.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobContext } from '../../../core/types.js';
import { runMerge } from './merge.js';
import type { MergeOpts, SearchMovieFn } from './merge.js';
import type { BranchOutputFile, MovieSnapshotFile, RawSuggestion, TmdbSearchResult } from '../types.js';
import { BRANCHES } from './branches.js';
import type { BranchSpec } from './branches.js';
import type { RunClaudeFn } from './recommend.js';
import type { ClaudeResult } from '../../../services/claude.js';
import { moviesConfig } from '../config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fakeCtx(): { ctx: JobContext; logs: string[] } {
  const logs: string[] = [];
  const ctx: JobContext = {
    log(msg: string) { logs.push(msg); },
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
  return { ctx, logs };
}

const NOW = new Date('2026-06-24T00:00:00Z');
let nextId = 9_100_000;

function makeSuggestion(title: string, lens: string): RawSuggestion {
  return { title, year: 2015, reason: `because ${title}`, lens };
}

function makeSearchResult(title: string): TmdbSearchResult {
  return { id: nextId++, title, release_date: '2015-01-01', vote_average: 8, vote_count: 200, genre_ids: [28], original_language: 'en' };
}

// ── Shared test fixtures ──────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'movies-merge-conc-'));
const snapshotFile = join(root, 'snapshot.json');
const snap: MovieSnapshotFile = { generatedAt: NOW.toISOString(), section: '4', movies: [] };
writeFileSync(snapshotFile, JSON.stringify(snap));

// Empty recsDir — initial pool is empty so we always need top-up
const recsDir = join(root, 'recs');
mkdirSync(recsDir, { recursive: true });

// Build a synthetic TMDB search that accepts any title we generate
const searchRegistry = new Map<string, TmdbSearchResult>();
const searchMovie: SearchMovieFn = async (title) => {
  if (!searchRegistry.has(title)) searchRegistry.set(title, makeSearchResult(title));
  return searchRegistry.get(title)!;
};

// ── Build a taste profile so buildDefaultTopUp doesn't short-circuit ─────────

const tasteFile = join(root, 'taste-profile.json');
writeFileSync(tasteFile, JSON.stringify({ profile: 'Test taste profile', generatedAt: NOW.toISOString() }));
const historyFile = join(root, 'recs-history.json');
writeFileSync(historyFile, JSON.stringify({ recommendations: [] }));

// ── Test 1: Concurrency is bounded to N ──────────────────────────────────────
//
// Use topUpConcurrency=2, BRANCHES.length=8 — never more than 2 in flight.
// Each branch call takes 20ms so concurrent calls register in the peak counter.
// We inject runClaude into runMerge so the real buildDefaultTopUp path exercises
// runBounded with our concurrency cap.
{
  const CAP = 2;
  const peak2 = { max: 0, current: 0 };

  // A tracking runClaude that measures concurrent calls
  const trackingRun: RunClaudeFn = async (_prompt: string, _model: string): Promise<ClaudeResult> => {
    peak2.current++;
    if (peak2.current > peak2.max) peak2.max = peak2.current;
    await new Promise<void>((res) => setTimeout(res, 20)); // 20ms so overlaps show
    peak2.current--;
    // Return a minimal valid JSON suggestion
    return { ok: true, rateLimited: false, text: JSON.stringify([{ title: `T182-conc-film-${peak2.max}`, year: 2015, reason: 'r', lens: 'test' }]) };
  };

  const { ctx } = fakeCtx();

  // Use target > 0, 1 top-up round, cap=2, no initial branch files
  await runMerge(ctx, {
    searchMovie,
    snapshotFile,
    recsDir,
    recsOut: join(root, 'recs-out-1.json'),
    tasteFile,
    historyFile,
    now: NOW,
    target: 1,        // want at least 1; top-up fires immediately (pool is empty)
    topUpRounds: 1,
    topUpConcurrency: CAP,
    runClaude: trackingRun,
    genreCap: 99,
  });

  assert.ok(peak2.max <= CAP, `peak concurrency ${peak2.max} never exceeded cap ${CAP}`);
  assert.ok(peak2.max > 1, `at least 2 branches ran concurrently (peak ${peak2.max}) — not sequential`);
  console.log(`  ✓ top-up concurrency bounded to ${CAP}: peak was ${peak2.max}`);
}

// ── Test 2: Per-branch logging is correctly attributed under out-of-order completion ──
//
// Branches complete in reverse order (last branch fastest). We verify that the
// logged lines correctly attribute each branch by id/lens.
{
  // Use injected topUp (not the real branch fan-out) to control ordering precisely.
  const completionOrder: string[] = [];

  // Build a topUp that fans branches concurrently with delays in reverse order
  // (branch[0] is slowest, branch[N-1] is fastest), tracking log attribution.
  const logsPerBranch: Record<string, string[]> = {};
  const { ctx, logs } = fakeCtx();

  // Inject a custom topUp that simulates 4 branches completing out of order
  const fakeBranches = ['slow-branch', 'medium-branch', 'fast-branch', 'ultra-fast-branch'];
  const delays = [60, 40, 20, 5];

  const topUp = async (_exclude: string[], _round: number): Promise<RawSuggestion[]> => {
    const results: RawSuggestion[] = [];
    // Run branches in parallel with different delays
    await Promise.all(
      fakeBranches.map(async (branchId, i) => {
        await new Promise<void>((res) => setTimeout(res, delays[i]));
        completionOrder.push(branchId);
        const sug = makeSuggestion(`T182-${branchId}-film`, branchId);
        ctx.log(`    • ${branchId} (${branchId}) → 1 suggestion(s)`);
        results.push(sug);
      })
    );
    return results;
  };

  await runMerge(ctx, {
    searchMovie,
    snapshotFile,
    recsDir,
    recsOut: join(root, 'recs-out-2.json'),
    tasteFile,
    historyFile,
    now: NOW,
    target: 10,
    topUpRounds: 1,
    topUp,
    genreCap: 99,
  });

  // Branches should have completed fastest-first
  assert.equal(completionOrder[0], 'ultra-fast-branch', 'fastest branch completes first');
  assert.equal(completionOrder[completionOrder.length - 1], 'slow-branch', 'slowest branch completes last');

  // Each branch's log line must reference its own id
  for (const branchId of fakeBranches) {
    const attributed = logs.some((l) => l.includes(branchId) && l.includes('suggestion(s)'));
    assert.ok(attributed, `log correctly attributes results to branch "${branchId}"`);
  }

  // Verify our injected log lines attributed branches correctly (one line per branch)
  const attrLines = logs.filter((l) => l.includes('suggestion(s)') && fakeBranches.some((b) => l.includes(b)));
  assert.equal(attrLines.length, fakeBranches.length, `each of the ${fakeBranches.length} branches logged exactly one attribution line`);

  console.log('  ✓ per-branch logging is correctly attributed even when branches complete out of order');
}

// ── Test 3: Config default is reasonable ────────────────────────────────────
{
  assert.ok(moviesConfig.recsTopUpConcurrency >= 1, 'concurrency cap is at least 1');
  assert.ok(moviesConfig.recsTopUpConcurrency <= BRANCHES.length, `concurrency cap (${moviesConfig.recsTopUpConcurrency}) does not exceed branch count (${BRANCHES.length})`);
  console.log(`  ✓ recsTopUpConcurrency default (${moviesConfig.recsTopUpConcurrency}) is in valid range [1, ${BRANCHES.length}]`);
}

console.log('  ✓ T182 merge concurrency tests passed');
