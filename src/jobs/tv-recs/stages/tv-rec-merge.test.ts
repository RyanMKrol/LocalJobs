// tv-rec-merge tests — hermetic, scratch DB only, no live TMDB.
// Covers: dedupe, quality-bar filter, owned/already-recommended/ignored exclusions, genre balancing.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ignoreSurfacedItem, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { RECS_JOB, recKey } from '../recs.js';
import { runTvRecMerge } from './tv-rec-merge.js';
import type { MergeOpts, SearchTvFn, TmdbTvSearchResult } from './tv-rec-merge.js';
import type { BranchOutputFile, RawSuggestion, RecommendationsFile, TvSnapshotFile } from '../types.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

const NOW = new Date('2026-06-24T00:00:00Z');
const OWNED_ID = 9900001;
const PREV_REC_ID = 9900002;
const IGNORED_ID = 9900003;

// ── Synthetic TMDB registry ──
const REG = new Map<string, TmdbTvSearchResult>();
let nextId = 8_800_000;

function show(
  title: string,
  opts: { rating?: number; votes?: number; genre?: number; year?: number } = {},
): RawSuggestion {
  const id = nextId++;
  const year = opts.year ?? 2010;
  REG.set(title, {
    id, name: title, first_air_date: `${year}-01-01`,
    vote_average: opts.rating ?? 7.5, vote_count: opts.votes ?? 200,
    genre_ids: [opts.genre ?? 18],
  });
  return { title, year, reason: `because ${title}`, lens: 'serendipity' };
}

const searchTv: SearchTvFn = async (title) => REG.get(title) ?? null;

// Register the special IDs so tests that check them can resolve titles.
REG.set('Owned Show', { id: OWNED_ID, name: 'Owned Show', first_air_date: '2010-01-01', vote_average: 8, vote_count: 300, genre_ids: [18] });
REG.set('Old Recommendation', { id: PREV_REC_ID, name: 'Old Recommendation', first_air_date: '2005-01-01', vote_average: 8, vote_count: 300, genre_ids: [18] });
REG.set('Ignored Show', { id: IGNORED_ID, name: 'Ignored Show', first_air_date: '2008-01-01', vote_average: 8, vote_count: 300, genre_ids: [18] });

// Pre-seed ledger: previously-recommended + ignored.
markWorkItem(RECS_JOB, recKey(PREV_REC_ID), 'success');
ignoreSurfacedItem(RECS_JOB, recKey(IGNORED_ID));

const root = mkdtempSync(join(tmpdir(), 'tv-merge-'));
const snap: TvSnapshotFile = {
  generatedAt: NOW.toISOString(), section: '5',
  shows: [{ title: 'Owned Show', year: 2010, tmdbId: OWNED_ID, ratingKey: '1', genres: ['Drama'], roles: [], countries: [], studio: null, audienceRating: null, rating: null, seasonCount: 1 }],
};
const snapshotFile = join(root, 'snapshot.json');
writeFileSync(snapshotFile, JSON.stringify(snap));

let caseN = 0;
async function run(suggestions: RawSuggestion[], opts: Partial<MergeOpts> = {}): Promise<RecommendationsFile> {
  const dir = join(root, `case-${caseN++}`);
  const recsDir = join(dir, 'recs');
  mkdirSync(recsDir, { recursive: true });
  const recsOut = join(dir, 'recommendations.json');
  const branch: BranchOutputFile = { branchId: 'tv-rec-random-1', lens: 'serendipity', generatedAt: NOW.toISOString(), suggestions };
  writeFileSync(join(recsDir, 'tv-rec-random-1.json'), JSON.stringify(branch));
  await runTvRecMerge(fakeCtx(), {
    searchTv, snapshotFile, recsDir, recsOut, now: NOW,
    topUp: async () => [],
    ...opts,
  });
  return JSON.parse(readFileSync(recsOut, 'utf8')) as RecommendationsFile;
}

// ── 1. Drops hallucinated, owned, previously-recommended, and ignored ──
{
  const DRAMA = 18, ACTION = 10759;
  const valid = show('Good Show', { genre: DRAMA });
  const sug = (title: string, lens = 'serendipity'): RawSuggestion => ({ title, year: 2010, reason: `because ${title}`, lens });
  const out = await run([
    valid,
    sug('Totally Made Up Show'),   // no TMDB match
    sug('Owned Show'),             // owned
    sug('Old Recommendation'),     // previously recommended
    sug('Ignored Show'),           // owner-ignored
  ]);
  const ids = new Set(out.recommendations.map((r) => r.tmdbId));
  const titles = new Set(out.recommendations.map((r) => r.title));
  assert.ok(!titles.has('Totally Made Up Show'), 'hallucinated (no TMDB match) dropped');
  assert.ok(!ids.has(OWNED_ID), 'already-owned dropped');
  assert.ok(!ids.has(PREV_REC_ID), 'previously-recommended dropped');
  assert.ok(!ids.has(IGNORED_ID), 'owner-ignored dropped');
  assert.ok(titles.has('Good Show'), 'a valid novel show is kept');
  console.log('  ✓ merge drops hallucinated, owned, previously-recommended, and ignored shows');
}

// ── 2. Quality bar: drops sub-7.0, too-few-votes; keeps ≥7.0 well-voted ──
{
  const great = show('Great Show', { rating: 8.0, votes: 300 });
  const boundary = show('Just At Bar', { rating: 7.0, votes: 50 });
  const lowRated = show('Low Rated', { rating: 6.5, votes: 1000 });
  const fewVotes = show('Few Votes', { rating: 9.0, votes: 10 });
  const out = await run([great, boundary, lowRated, fewVotes], { target: 10, genreCap: 99 });
  const t = new Set(out.recommendations.map((r) => r.title));
  assert.ok(t.has('Great Show'), 'well-rated + well-voted show kept');
  assert.ok(t.has('Just At Bar'), 'exactly on the bar is kept');
  assert.ok(!t.has('Low Rated'), 'sub-7.0 rating dropped');
  assert.ok(!t.has('Few Votes'), 'too few votes dropped');
  console.log('  ✓ merge enforces the quality bar (rating ≥7.0 AND votes ≥50)');
}

// ── 3. Cross-branch dedup: same id from two branches → one entry, both lenses merged ──
{
  const DRAMA = 18;
  const baseId = nextId++;
  const altTitle = `Dual Branch Show ${baseId}`;
  REG.set(`Show A ${baseId}`, { id: baseId, name: `Show A ${baseId}`, first_air_date: '2012-01-01', vote_average: 8, vote_count: 200, genre_ids: [DRAMA] });
  REG.set(altTitle, { id: baseId, name: `Show A ${baseId}`, first_air_date: '2012-01-01', vote_average: 8, vote_count: 200, genre_ids: [DRAMA] });

  const dir = join(root, `case-${caseN++}`);
  const recsDir = join(dir, 'recs');
  mkdirSync(recsDir, { recursive: true });
  const recsOut = join(dir, 'recommendations.json');
  const branchA: BranchOutputFile = { branchId: 'tv-rec-random-1', lens: 'serendipity', generatedAt: NOW.toISOString(), suggestions: [{ title: `Show A ${baseId}`, year: 2012, reason: 'r', lens: 'serendipity' }] };
  const branchB: BranchOutputFile = { branchId: 'tv-rec-world', lens: 'world-tv', generatedAt: NOW.toISOString(), suggestions: [{ title: altTitle, year: 2012, reason: 'r', lens: 'world-tv' }] };
  writeFileSync(join(recsDir, 'tv-rec-random-1.json'), JSON.stringify(branchA));
  writeFileSync(join(recsDir, 'tv-rec-world.json'), JSON.stringify(branchB));
  await runTvRecMerge(fakeCtx(), { searchTv, snapshotFile, recsDir, recsOut, now: NOW, topUp: async () => [] });
  const out = JSON.parse(readFileSync(recsOut, 'utf8')) as RecommendationsFile;

  const matches = out.recommendations.filter((r) => r.tmdbId === baseId);
  assert.equal(matches.length, 1, 'cross-branch duplicate appears exactly once');
  assert.match(matches[0].lens, /serendipity/, 'first lens present');
  assert.match(matches[0].lens, /world-tv/, 'second lens merged in');
  console.log('  ✓ merge dedupes across branches and merges lenses');
}

// ── 4. Genre balancing: per-genre cap respected ──
{
  const DRAMA = 18, COMEDY = 35;
  // 4 Drama shows, 1 Comedy — cap at 2/genre, target 10 → expect 2 Drama + 1 Comedy
  const dramas = [
    show(`Drama G1`, { genre: DRAMA }),
    show(`Drama G2`, { genre: DRAMA }),
    show(`Drama G3`, { genre: DRAMA }),
    show(`Drama G4`, { genre: DRAMA }),
  ];
  const comedy = show(`Comedy G1`, { genre: COMEDY });
  const out = await run([...dramas, comedy], { target: 10, genreCap: 2 });
  const genreCounts: Record<string, number> = {};
  for (const r of out.recommendations) genreCounts[r.genre] = (genreCounts[r.genre] ?? 0) + 1;
  assert.ok((genreCounts['Drama'] ?? 0) <= 2, 'Drama capped at 2');
  assert.ok((genreCounts['Comedy'] ?? 0) >= 1, 'Comedy still present');
  console.log('  ✓ merge respects the per-genre cap');
}

// ── 5. Top-up loop: requests more when under target, stops when target reached ──
{
  const DRAMA = 18, CRIME = 80;
  const initial = [
    show('Init Drama 1', { genre: DRAMA }),
    show('Init Drama 2', { genre: DRAMA }),
  ];
  let calls = 0;
  const topUpFn = async (): Promise<RawSuggestion[]> => {
    calls++;
    return [
      show(`TopUp Crime ${calls}a`, { genre: CRIME }),
      show(`TopUp Crime ${calls}b`, { genre: CRIME }),
    ];
  };
  const out = await run(initial, { target: 4, genreCap: 99, topUpRounds: 5, topUp: topUpFn });
  assert.ok(out.recommendations.length >= 4, `reached target of 4 (got ${out.recommendations.length})`);
  assert.equal(calls, 1, 'stopped after one top-up round (target reached)');
  console.log('  ✓ top-up requests more when under target and stops when target reached');
}

// ── 6. Top-up loop stops at round cap when target cannot be reached ──
{
  const DRAMA = 18;
  // initial has 1 good show; top-up returns nothing new each round
  const initial = [show('Solo Drama', { genre: DRAMA })];
  let calls = 0;
  const topUpFn = async (): Promise<RawSuggestion[]> => { calls++; return []; };
  await run(initial, { target: 20, genreCap: 99, topUpRounds: 3, topUp: topUpFn });
  // Should stop at round 1 (no new suggestions) — not waste all 3 rounds.
  assert.ok(calls <= 1, `stopped early when no new suggestions (calls=${calls})`);
  console.log('  ✓ top-up stops early when no new suggestions arrive');
}
