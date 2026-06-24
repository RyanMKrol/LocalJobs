// Merge-stage tests — CODE-side correctness enforcement. Hermetic: NO live TMDB
// (an injected searchMovie), synthetic branch files + snapshot, scratch DB ledger.
// Covers: drops a hallucinated title (no TMDB match), an already-owned title, and a
// previously-recommended/ignored title; KEEPS a valid novel one; cross-branch dedup
// (two titles → same tmdb id merge lenses); and per-genre output balancing (cap).
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ignoreSurfacedItem, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { RECS_JOB, recKey } from '../recs.js';
import { runMerge } from './merge.js';
import type { SearchMovieFn } from './merge.js';
import type { BranchOutputFile, MovieSnapshotFile, RecommendationsFile, RawSuggestion, TmdbSearchResult } from '../types.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

const NOW = new Date('2026-06-24T00:00:00Z');
const OWNED_ID = 111;             // a film already in the library
const PREV_REC_ID = 8800001;      // previously recommended (success ledger row)
const IGNORED_ID = 8800002;       // owner-ignored recommendation

// Distinct novel ids so this test is independent of other ledger rows.
const ACT = [5001, 5002, 5003, 5004, 5005]; // 5 Action novel films
const DRAMA = 5100;

const dir = mkdtempSync(join(tmpdir(), 'movies-merge-'));
const recsDir = join(dir, 'recs');
mkdirSync(recsDir, { recursive: true });
const snapshotFile = join(dir, 'snapshot.json');
const recsOut = join(dir, 'recommendations.json');

// Snapshot = the owned library (only OWNED_ID matters here).
const snap: MovieSnapshotFile = {
  generatedAt: NOW.toISOString(), section: '4',
  movies: [{ title: 'Owned', year: 2000, tmdbId: OWNED_ID, ratingKey: '1', genres: ['Action'], directors: [], countries: [], audienceRating: null, rating: null }],
};
writeFileSync(snapshotFile, JSON.stringify(snap));

// Two branch files. Branch A (serendipity) carries the bulk; Branch B (world-cinema)
// repeats "Action A" by an alternate title (→ same id 5001, exercises mergeLens) plus
// an already-ignored pick.
const sug = (title: string, year: number | null, lens: string): RawSuggestion => ({ title, year, reason: `because ${title}`, lens });
const branchA: BranchOutputFile = {
  branchId: 'rec-random-1', lens: 'serendipity', generatedAt: NOW.toISOString(),
  suggestions: [
    sug('Action A', 2001, 'serendipity'),
    sug('Action B', 2002, 'serendipity'),
    sug('Action C', 2003, 'serendipity'),
    sug('Action D', 2004, 'serendipity'),
    sug('Action E', 2005, 'serendipity'),
    sug('Drama One', 2006, 'serendipity'),
    sug('Totally Made Up Film', 1990, 'serendipity'), // hallucination → no TMDB match
    sug('Owned Movie', 2000, 'serendipity'),          // resolves to OWNED_ID
    sug('Old Recommendation', 1999, 'serendipity'),   // resolves to PREV_REC_ID
  ],
};
const branchB: BranchOutputFile = {
  branchId: 'rec-world-cinema', lens: 'world-cinema', generatedAt: NOW.toISOString(),
  suggestions: [
    sug('Action A Alternate Title', 2001, 'world-cinema'), // → id 5001 (mergeLens)
    sug('An Ignored Pick', 2010, 'world-cinema'),          // resolves to IGNORED_ID
  ],
};
writeFileSync(join(recsDir, 'rec-random-1.json'), JSON.stringify(branchA));
writeFileSync(join(recsDir, 'rec-world-cinema.json'), JSON.stringify(branchB));

// Injected TMDB search: title → result (or null = hallucination).
const result = (id: number, title: string, year: number, genre: number): TmdbSearchResult =>
  ({ id, title, release_date: `${year}-01-01`, vote_average: 7, vote_count: 100, genre_ids: [genre], original_language: 'en' });
const SEARCH: Record<string, TmdbSearchResult | null> = {
  'Action A': result(ACT[0], 'Action A', 2001, 28),
  'Action A Alternate Title': result(ACT[0], 'Action A', 2001, 28), // same id, different title
  'Action B': result(ACT[1], 'Action B', 2002, 28),
  'Action C': result(ACT[2], 'Action C', 2003, 28),
  'Action D': result(ACT[3], 'Action D', 2004, 28),
  'Action E': result(ACT[4], 'Action E', 2005, 28),
  'Drama One': result(DRAMA, 'Drama One', 2006, 18),
  'Totally Made Up Film': null,
  'Owned Movie': result(OWNED_ID, 'Owned', 2000, 28),
  'Old Recommendation': result(PREV_REC_ID, 'Old Recommendation', 1999, 28),
  'An Ignored Pick': result(IGNORED_ID, 'An Ignored Pick', 2010, 80),
};
const searchMovie: SearchMovieFn = async (title) => (title in SEARCH ? SEARCH[title] : null);

// Pre-seed the recs ledger: one previously recommended, one ignored.
markWorkItem(RECS_JOB, recKey(PREV_REC_ID), 'success');
ignoreSurfacedItem(RECS_JOB, recKey(IGNORED_ID));

// Inject an empty top-up so this hermetic test never reaches the live default
// (branch fan-out) path; the top-up loop itself is covered in merge-quality.test.ts.
await runMerge(fakeCtx(), { searchMovie, snapshotFile, recsDir, recsOut, now: NOW, topUp: async () => [] });

const out = JSON.parse(readFileSync(recsOut, 'utf8')) as RecommendationsFile;
const recs = out.recommendations;
const ids = new Set(recs.map((r) => r.tmdbId));

// ── Verification: drops hallucinated / owned / previously-recommended / ignored ──
assert.ok(!recs.some((r) => r.title === 'Totally Made Up Film'), 'hallucinated (no TMDB match) dropped');
assert.ok(!ids.has(OWNED_ID), 'already-owned dropped');
assert.ok(!ids.has(PREV_REC_ID), 'previously-recommended dropped');
assert.ok(!ids.has(IGNORED_ID), 'owner-ignored dropped');
console.log('  ✓ merge drops hallucinated, owned, previously-recommended, and ignored picks');

// ── Keeps the valid novel ones ──
assert.ok(ids.has(DRAMA), 'a valid novel Drama is kept');
assert.ok(ids.has(ACT[0]), 'a valid novel Action is kept');
console.log('  ✓ merge keeps valid novel recommendations');

// ── Cross-branch dedup: id 5001 appears ONCE, with both lenses merged ──
const a1 = recs.filter((r) => r.tmdbId === ACT[0]);
assert.equal(a1.length, 1, 'a film resolved from two branches appears once');
assert.match(a1[0].lens, /serendipity/);
assert.match(a1[0].lens, /world-cinema/);
console.log('  ✓ merge dedupes across branches and merges lenses');

// ── Balance: Action capped at the per-genre cap (default 3), Drama present ──
const actionCount = recs.filter((r) => r.genre === 'Action').length;
assert.ok(actionCount <= 3, `Action capped per genre (got ${actionCount})`);
assert.equal(actionCount, 3, 'exactly the cap of Action survive (5 verified → 3 kept)');
assert.ok(recs.some((r) => r.genre === 'Drama'), 'the lone Drama survives balancing');
console.log('  ✓ merge balances the output per genre (cap enforced)');

console.log('  ✓ movies merge verify/dedup/balance tests passed');
