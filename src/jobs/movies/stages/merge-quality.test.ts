// T162 merge tests — the QUALITY bar + the bounded TOP-UP loop + config wiring.
// Hermetic: an injected searchMovie (a synthetic TMDB registry), an injected
// topUp (never the live branch fan-out), synthetic branch files, scratch DB.
// Covers: drops a sub-7.0 rating, drops a too-few-votes pick, keeps a ≥7.0
// well-voted one (incl. the exact boundary); the top-up loop requests more when
// under target, stops on reaching target, stops at the round cap, stops when no
// new titles arrive; the genre cap still holds after top-up; thresholds+target
// are config/opts-driven.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobContext } from '../../../core/types.js';
import { moviesConfig } from '../config.js';
import { runMerge } from './merge.js';
import type { MergeOpts, SearchMovieFn } from './merge.js';
import type { BranchOutputFile, MovieSnapshotFile, RawSuggestion, RecommendationsFile, TmdbSearchResult } from '../types.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}
const NOW = new Date('2026-06-24T00:00:00Z');

// Genre id shorthands (TMDB).
const ACTION = 28, DRAMA = 18, COMEDY = 35, CRIME = 80, HORROR = 27, FANTASY = 14;

// A synthetic TMDB registry: film() registers a search result and returns the raw
// suggestion the branches would have produced. Unique ids avoid ledger collisions.
const REG = new Map<string, TmdbSearchResult>();
let nextId = 7_300_000;
function film(
  title: string,
  opts: { rating?: number; votes?: number; genre?: number; year?: number } = {},
): RawSuggestion {
  const id = nextId++;
  const year = opts.year ?? 2010;
  REG.set(title, {
    id, title, release_date: `${year}-01-01`,
    vote_average: opts.rating ?? 8, vote_count: opts.votes ?? 200,
    genre_ids: [opts.genre ?? ACTION], original_language: 'en',
  });
  return { title, year, reason: `because ${title}`, lens: 'serendipity' };
}
const searchMovie: SearchMovieFn = async (title) => REG.get(title) ?? null;

const root = mkdtempSync(join(tmpdir(), 'movies-mergeq-'));
const snapshotFile = join(root, 'snapshot.json');
const snap: MovieSnapshotFile = { generatedAt: NOW.toISOString(), section: '4', movies: [] };
writeFileSync(snapshotFile, JSON.stringify(snap));

let caseN = 0;
/** Spin up a fresh recs dir with ONE branch file of the given suggestions, then
 *  run merge with the shared snapshot + synthetic search and return the output. */
async function run(suggestions: RawSuggestion[], opts: Partial<MergeOpts>): Promise<RecommendationsFile> {
  const dir = join(root, `case-${caseN++}`);
  const recsDir = join(dir, 'recs');
  mkdirSync(recsDir, { recursive: true });
  const recsOut = join(dir, 'recommendations.json');
  const branch: BranchOutputFile = { branchId: 'rec-random-1', lens: 'serendipity', generatedAt: NOW.toISOString(), suggestions };
  writeFileSync(join(recsDir, 'rec-random-1.json'), JSON.stringify(branch));
  await runMerge(fakeCtx(), {
    searchMovie, snapshotFile, recsDir, recsOut, now: NOW,
    // Default to a no-op top-up so a case that doesn't test it never fans out.
    topUp: async () => [],
    ...opts,
  });
  return JSON.parse(readFileSync(recsOut, 'utf8')) as RecommendationsFile;
}

// ── 1. Quality bar: drops sub-7.0 + too-few-votes, keeps ≥7.0 well-voted ──
{
  const great = film('Great Film', { rating: 7.5, votes: 200, genre: ACTION });
  const boundary = film('Just At Bar', { rating: 7.0, votes: 50, genre: DRAMA }); // exactly on the bar → kept
  const lowRated = film('Low Rated', { rating: 6.5, votes: 1000, genre: CRIME }); // rating below → dropped
  const fewVotes = film('Few Votes', { rating: 9.0, votes: 10, genre: COMEDY });  // votes below → dropped
  const out = await run([great, boundary, lowRated, fewVotes], { target: 10, genreCap: 99 });
  const titles = new Set(out.recommendations.map((r) => r.title));
  assert.ok(titles.has('Great Film'), 'a well-rated, well-voted film is kept');
  assert.ok(titles.has('Just At Bar'), 'a film exactly on the rating+vote bar is kept');
  assert.ok(!titles.has('Low Rated'), 'a sub-7.0 rating is dropped');
  assert.ok(!titles.has('Few Votes'), 'a high rating with too few votes is dropped');
  console.log('  ✓ merge enforces the TMDB quality bar (rating ≥ threshold AND vote_count ≥ floor)');
}

// ── 2. Top-up loop STOPS EARLY once the target is reached ──
{
  const initial = [film('Init A', { genre: ACTION }), film('Init B', { genre: DRAMA }), film('Init C', { genre: COMEDY })];
  let calls = 0;
  const topUp = async (): Promise<RawSuggestion[]> => {
    calls++;
    return [film(`TopUp-${calls}-x`, { genre: HORROR }), film(`TopUp-${calls}-y`, { genre: CRIME }), film(`TopUp-${calls}-z`, { genre: FANTASY })];
  };
  const out = await run(initial, { target: 6, genreCap: 99, topUpRounds: 5, topUp });
  assert.equal(out.recommendations.length, 6, 'reaches the target of 6');
  assert.equal(calls, 1, 'one top-up round suffices → loop stops as soon as target is hit');
  console.log('  ✓ top-up requests more when under target and stops the moment the target is reached');
}

// ── 3. Top-up loop STOPS AT THE ROUND CAP when it can never reach the target ──
{
  const initial = [film('Cap A', { genre: ACTION }), film('Cap B', { genre: DRAMA })];
  let calls = 0;
  const topUp = async (): Promise<RawSuggestion[]> => {
    calls++;
    return [film(`Cap-r${calls}-1`, { genre: HORROR }), film(`Cap-r${calls}-2`, { genre: CRIME }), film(`Cap-r${calls}-3`, { genre: FANTASY })];
  };
  const out = await run(initial, { target: 15, genreCap: 99, topUpRounds: 2, topUp });
  assert.equal(calls, 2, 'top-up is bounded to topUpRounds (2) even though still under target');
  assert.equal(out.recommendations.length, 2 + 3 + 3, 'all initial + both rounds survive (8 < 15) — outputs what it has');
  console.log('  ✓ top-up loop is bounded — stops at the round cap and outputs what it has');
}

// ── 4. Top-up loop STOPS when a round returns no NEW titles ──
{
  const initial = [film('Dup A', { genre: ACTION }), film('Dup B', { genre: DRAMA })];
  let calls = 0;
  const topUp = async (): Promise<RawSuggestion[]> => {
    calls++;
    // Returns the SAME already-considered titles every time → zero new each round.
    return initial.map((s) => ({ ...s }));
  };
  const out = await run(initial, { target: 15, genreCap: 99, topUpRounds: 4, topUp });
  assert.equal(calls, 1, 'a round with no new titles ends the loop immediately');
  assert.equal(out.recommendations.length, 2, 'only the initial picks survive');
  console.log('  ✓ top-up stops as soon as a round yields no new titles');
}

// ── 5. Genre balance still holds after top-up (per-genre cap) ──
{
  // 5 Action in the pool, but cap is 3 → only 3 Action survive; top-up adds OTHER
  // genres so the list grows without ever exceeding the Action cap.
  const initial = [
    film('Act1', { genre: ACTION }), film('Act2', { genre: ACTION }), film('Act3', { genre: ACTION }),
    film('Act4', { genre: ACTION }), film('Act5', { genre: ACTION }),
  ];
  let calls = 0;
  const topUp = async (): Promise<RawSuggestion[]> => {
    calls++;
    return [film(`Bal-r${calls}-d`, { genre: DRAMA }), film(`Bal-r${calls}-c`, { genre: COMEDY }), film(`Bal-r${calls}-h`, { genre: HORROR })];
  };
  const out = await run(initial, { target: 9, genreCap: 3, topUpRounds: 5, topUp });
  const actionCount = out.recommendations.filter((r) => r.genre === 'Action').length;
  assert.ok(actionCount <= 3, `Action stays capped at 3 after top-up (got ${actionCount})`);
  assert.ok(out.recommendations.length > 3, 'the list grows past one genre via diverse top-up picks');
  assert.ok(out.recommendations.some((r) => r.genre !== 'Action'), 'non-Action genres are present (balanced)');
  console.log('  ✓ genre balance (per-genre cap) is preserved across the top-up loop');
}

// ── 6. Threshold + target + cap are config-driven (defaults match the spec) ──
{
  assert.equal(moviesConfig.recsMinRating, 7.0, 'default rating threshold is 7.0');
  assert.equal(moviesConfig.recsMinVotes, 50, 'default vote floor is 50');
  assert.equal(moviesConfig.recsTarget, 15, 'default target is 15');
  assert.ok(moviesConfig.recsTopUpRounds >= 1, 'top-up rounds is a positive bound');
  assert.ok(moviesConfig.recsPerBranchAsk >= 8, 'per-branch ask is raised for headroom');

  // Overriding the threshold via opts changes what survives — proving it's not hardcoded.
  const mid = film('Mid Six Five', { rating: 6.5, votes: 500, genre: ACTION });
  const strict = await run([mid], { target: 5, genreCap: 99, minRating: 7.0 });
  assert.equal(strict.recommendations.length, 0, 'at the default 7.0 bar the 6.5 film is dropped');
  const lenient = await run([mid], { target: 5, genreCap: 99, minRating: 6.0 });
  assert.equal(lenient.recommendations.length, 1, 'lowering the bar to 6.0 lets the 6.5 film through');
  console.log('  ✓ quality threshold + target are config/opts-driven, not hardcoded');
}

console.log('  ✓ movies merge quality + top-up tests passed');
