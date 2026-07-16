// Merge-stage tests for the shared pipeline (T561). Hermetic: NO live TMDB (an
// injected search), synthetic branch files + snapshot, scratch DB. Two SYNTHETIC
// domains stand in for movies/tv-recs (their own workflows exercise the real
// wiring in stages/merge.test.ts / stages/tv-rec-merge.test.ts) — proving the
// SAME shared runMerge serves two differently-configured domains (distinct
// genre tables, TMDB fields, job names) without cross-contamination, and that
// its output is deterministic: a golden-file assertion of the exact
// recommendations.json produced from a fixed fixture + seeded flow.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorkItem, markWorkItem, workItemCounts } from '../../db/store.js';
import { recKey } from './pure.js';
import type { JobContext } from '../types.js';
import { runMerge } from './merge.js';
import type { RecommenderConfig, RecommenderDomain } from './types.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

interface Item { title: string; year: number | null; tmdbId: number | null; genres: string[] }
interface Profile { genres: Record<string, number> }

function makeConfig(dir: string): RecommenderConfig {
  return {
    snapshotOut: join(dir, 'snapshot.json'),
    tasteOut: join(dir, 'taste.json'),
    recsHistoryOut: join(dir, 'history.json'),
    recsDir: join(dir, 'recs'),
    recsOut: join(dir, 'recommendations.json'),
    reportDir: dir,
    recsModel: 'claude-sonnet-5',
    recsSampleSize: 50,
    recsPerBranchAsk: 9,
    recsTarget: 15,
    recsGenreCap: 3,
    recsMinRating: 7.0,
    recsMinVotes: 50,
    recsTopUpRounds: 3,
    recsTopUpConcurrency: 4,
    recsRecentWindow: 40,
    recsHistoryContext: 200,
  };
}

/** Genre id → name table distinct per synthetic domain (proves no cross-contamination). */
function makeDomain(name: string, dir: string, genreTable: Record<number, string>): RecommenderDomain<Item, Profile> {
  return {
    recsJob: `${name}-recs`,
    snapshotStageName: `${name}-snapshot`,
    mergeStageName: `${name}-merge`,
    notifyStageName: `${name}-notify`,
    config: makeConfig(dir),
    branches: [],
    itemsOf: (snapshot) => (snapshot as { items: Item[] }).items ?? [],
    profileOf: (taste) => (taste as { profile: Profile }).profile,
    search: async () => null, // overridden per-test via opts.search
    genreName: (ids) => {
      for (const id of ids ?? []) if (genreTable[id]) return genreTable[id];
      return 'Unknown';
    },
    tmdbUrl: (tmdbId) => `https://example.test/${name}/${tmdbId}`,
    buildDigest: (recs) => ({ count: recs.length, title: `${recs.length} ${name} pick(s)`, body: recs.map((r) => r.title).join(', ') }),
    pushJob: name,
    pushTags: name,
    reportFilename: `${name}.md`,
    reportHeading: `# ${name} recommendations`,
    reportEmptyLine: `_No ${name} recommendations._`,
  };
}

const NOW = new Date('2026-06-24T00:00:00Z');

async function runFixture(domain: RecommenderDomain<Item, Profile>, dir: string) {
  const recsDir = domain.config.recsDir;
  mkdirSync(recsDir, { recursive: true });
  writeFileSync(domain.config.snapshotOut, JSON.stringify({ items: [{ title: 'Owned', year: 2000, tmdbId: 999, genres: ['A'] }] }));
  writeFileSync(join(recsDir, 'branch-a.json'), JSON.stringify({
    branchId: 'branch-a', lens: 'serendipity', generatedAt: NOW.toISOString(),
    suggestions: [
      { title: 'Good Pick', year: 2010, reason: 'great', lens: 'serendipity' },
      { title: 'Hallucinated', year: 2011, reason: 'x', lens: 'serendipity' },
      { title: 'Already Owned', year: 2000, reason: 'x', lens: 'serendipity' },
    ],
  }));
  const registry: Record<string, { id: number; title: string; year: number | null; vote_average: number; vote_count: number; genre_ids: number[] }> = {
    'Good Pick': { id: 12345, title: 'Good Pick', year: 2010, vote_average: 8, vote_count: 200, genre_ids: [1] },
    'Already Owned': { id: 999, title: 'Owned', year: 2000, vote_average: 8, vote_count: 200, genre_ids: [1] },
  };
  await runMerge(fakeCtx(), domain, {
    search: async (title) => registry[title] ?? null,
    now: NOW,
    topUp: async () => [],
  });
  return JSON.parse(readFileSync(domain.config.recsOut, 'utf8'));
}

// ── golden-file: movie-like domain ──
{
  const dir = mkdtempSync(join(tmpdir(), 'recommender-merge-movie-'));
  const domain = makeDomain('movie', dir, { 1: 'Action' });
  const out = await runFixture(domain, dir);
  assert.deepEqual(out, {
    generatedAt: NOW.toISOString(),
    pooled: 3,
    recommendations: [
      { tmdbId: 12345, title: 'Good Pick', year: 2010, reason: 'great', lens: 'serendipity', genre: 'Action', tmdbRating: 8 },
    ],
  }, 'movie-like domain produces the exact expected recommendations.json');
  console.log('  ✓ golden-file: movie-like domain merge output is byte-identical to the expected fixture');
}

// ── golden-file: tv-like domain (different genre table + job namespace, same pipeline) ──
{
  const dir = mkdtempSync(join(tmpdir(), 'recommender-merge-tv-'));
  const domain = makeDomain('tv', dir, { 1: 'Drama' });
  const out = await runFixture(domain, dir);
  assert.deepEqual(out, {
    generatedAt: NOW.toISOString(),
    pooled: 3,
    recommendations: [
      { tmdbId: 12345, title: 'Good Pick', year: 2010, reason: 'great', lens: 'serendipity', genre: 'Drama', tmdbRating: 8 },
    ],
  }, 'tv-like domain produces the exact expected recommendations.json (distinct genre name, same shape)');
  console.log('  ✓ golden-file: tv-like domain merge output is byte-identical to the expected fixture');
}

// ── already-recommended (ledger) exclusion is scoped per-domain recsJob ──
{
  const dir = mkdtempSync(join(tmpdir(), 'recommender-merge-scope-'));
  const domain = makeDomain('scoped', dir, { 1: 'Action' });
  markWorkItem(domain.recsJob, '12345', 'success');
  const out = await runFixture(domain, dir);
  assert.equal(out.recommendations.length, 0, 'a rec already recommended under this domain\'s ledger job is dropped');
  console.log('  ✓ merge drops a previously-recommended pick, scoped to the domain\'s own recsJob ledger');
}

// ── T602: merge writes one work_items row per final balanced recommendation,
// keyed by the merge stage's OWN job name (domain.mergeStageName), not
// domain.recsJob — and a same-day re-run upserts (no duplicates). ──
{
  const dir = mkdtempSync(join(tmpdir(), 'recommender-merge-ledger-'));
  const domain = makeDomain('ledgertest', dir, { 1: 'Action', 2: 'Comedy' });
  const recsDir = domain.config.recsDir;
  mkdirSync(recsDir, { recursive: true });
  writeFileSync(domain.config.snapshotOut, JSON.stringify({ items: [] }));
  writeFileSync(join(recsDir, 'branch-a.json'), JSON.stringify({
    branchId: 'branch-a', lens: 'serendipity', generatedAt: NOW.toISOString(),
    suggestions: [
      { title: 'Pick One', year: 2010, reason: 'reason one', lens: 'serendipity' },
      { title: 'Pick Two', year: 2012, reason: 'reason two', lens: 'targeted' },
    ],
  }));
  const registry: Record<string, { id: number; title: string; year: number | null; vote_average: number; vote_count: number; genre_ids: number[] }> = {
    'Pick One': { id: 111, title: 'Pick One', year: 2010, vote_average: 8, vote_count: 200, genre_ids: [1] },
    'Pick Two': { id: 222, title: 'Pick Two', year: 2012, vote_average: 9, vote_count: 300, genre_ids: [2] },
  };
  const runOnce = () => runMerge(fakeCtx(), domain, {
    search: async (title) => registry[title] ?? null,
    now: NOW,
    topUp: async () => [],
  });

  await runOnce();
  let out = JSON.parse(readFileSync(domain.config.recsOut, 'utf8'));
  assert.equal(out.recommendations.length, 2, 'both picks clear the quality bar and are balanced in');
  let counts = workItemCounts(domain.mergeStageName);
  assert.equal(counts.success, 2, 'merge stage ledger has one row per final recommendation');
  const item1 = getWorkItem(domain.mergeStageName, recKey(111));
  assert.ok(item1, 'row keyed by recKey(tmdbId) exists for the merge stage job name');
  assert.deepEqual(item1 && JSON.parse(item1.detail ?? 'null'), { title: 'Pick One', year: 2010, genre: 'Action', reason: 'reason one', lens: 'serendipity', tmdbRating: 8 },
    'detail carries this recommendation\'s own fields');
  assert.equal(item1?.status, 'success');

  // Re-run on the same day with the same balanced set — upserts, no duplicates.
  await runOnce();
  out = JSON.parse(readFileSync(domain.config.recsOut, 'utf8'));
  assert.equal(out.recommendations.length, 2);
  counts = workItemCounts(domain.mergeStageName);
  assert.equal(counts.success, 2, 're-run with the same balanced set upserts the same rows, not duplicates');
  console.log('  ✓ merge writes one idempotent work_items row per final recommendation, keyed by the merge stage\'s own job name');
}

console.log('  ✓ shared recommender merge golden-file tests passed');
