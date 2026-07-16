// T599: regression test for the `recordBranchLedgerRow` shadowing bug — every
// real branch job (movies + tv-recs) reported status='success' on a run yet
// wrote NO `work_items` row, because `coreMakeBranchJob`'s returned `run(ctx)`
// called this module's OWN `runBranch`, never the domain wrapper's `runBranch`
// (the only place that recorded the ledger row) — plain JS scoping, not a
// framework bug. The fix threads an `onBranchWritten` hook through
// `BranchRunOpts`/`makeBranchJob` so a domain's ledger write genuinely executes
// from the REAL job execution path (`run(ctx)`), not just from a direct call to
// the domain wrapper's exported `runBranch`.
//
// This drives `makeBranchJob(id, runOpts).run(ctx)` end-to-end (an injected
// `runClaude` — no live Claude call) for BOTH movies and tv-recs, and asserts a
// `work_items` row now exists for the branch's job name, keyed by `dayKey(now)`,
// with the existing `{ name, suggestions, path }` detail shape.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobContext } from '../types.js';
import type { ClaudeResult } from '../../services/claude.js';
import { dayKey } from '../dates.js';
import { getWorkItem } from '../../db/store.js';
import { makeBranchJob as makeMovieBranchJob } from '../../workflows/movies/stages/recommend.js';
import type { MovieSnapshotFile, TasteProfileFile } from '../../workflows/movies/types.js';
import { makeBranchJob as makeTvBranchJob } from '../../workflows/tv-recs/stages/recommend.js';
import type { TvSnapshotFile, TvTasteProfileFile } from '../../workflows/tv-recs/types.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}
const NOW = new Date('2026-07-16T00:00:00Z');
const ok = (text: string) => async (): Promise<ClaudeResult> => ({ ok: true, text, rateLimited: false });

// ── movies: rec-random-1 ──
{
  const dir = mkdtempSync(join(tmpdir(), 'movies-branchjob-'));
  const snapshotFile = join(dir, 'snapshot.json');
  const tasteFile = join(dir, 'taste.json');
  const historyFile = join(dir, 'history.json');
  const recsDir = dir;

  const snap: MovieSnapshotFile = {
    generatedAt: NOW.toISOString(), section: '4',
    movies: [
      { title: 'The Matrix', year: 1999, tmdbId: 603, ratingKey: '1', genres: ['Action'], directors: ['Lana Wachowski'], countries: ['United States'], audienceRating: 8, rating: 8 },
    ],
  };
  writeFileSync(snapshotFile, JSON.stringify(snap));
  const taste: TasteProfileFile = {
    generatedAt: NOW.toISOString(),
    profile: { totalMovies: 1, withTmdbId: 1, genres: { Action: 1 }, directors: {}, decades: { '1990s': 1 }, countries: { 'United States': 1 } },
  };
  writeFileSync(tasteFile, JSON.stringify(taste));

  const job = makeMovieBranchJob('rec-random-1', {
    runClaude: ok('{"recommendations":[{"title":"Stalker","year":1979,"reason":"a meditative sci-fi"}]}'),
    snapshotFile, tasteFile, historyFile, recsDir, now: NOW,
  });
  await job.run(fakeCtx());

  const row = getWorkItem('rec-random-1', dayKey(NOW));
  assert.ok(row, 'a work_items row exists for rec-random-1 after a real job run(ctx)');
  assert.equal(row?.status, 'success');
  const detail = row?.detail ? JSON.parse(row.detail) as { name?: string; suggestions?: number; path?: string } : null;
  assert.equal(detail?.name, 'rec-random-1 suggestions');
  assert.equal(detail?.suggestions, 1);
  assert.ok(detail?.path, 'detail.path recorded');
  console.log('  ✓ makeBranchJob("rec-random-1").run(ctx) records a work_items row (movies)');
}

// ── tv-recs: tv-rec-random-1 ──
{
  const dir = mkdtempSync(join(tmpdir(), 'tv-branchjob-'));
  const snapshotFile = join(dir, 'snapshot.json');
  const tasteFile = join(dir, 'taste.json');
  const historyFile = join(dir, 'history.json');
  const recsDir = dir;

  const snap: TvSnapshotFile = {
    generatedAt: NOW.toISOString(), section: '5',
    shows: [
      { title: 'The Wire', year: 2002, tmdbId: 1438, ratingKey: '1', genres: ['Crime'], roles: ['David Simon'], countries: ['United States'], studio: 'HBO', audienceRating: 9, rating: 9, seasonCount: 5 },
    ],
  };
  writeFileSync(snapshotFile, JSON.stringify(snap));
  const taste: TvTasteProfileFile = {
    generatedAt: NOW.toISOString(),
    profile: { totalShows: 1, withTmdbId: 1, genres: { Crime: 1 }, roles: {}, decades: { '2000s': 1 }, countries: { 'United States': 1 } },
  };
  writeFileSync(tasteFile, JSON.stringify(taste));

  const job = makeTvBranchJob('tv-rec-random-1', {
    runClaude: ok('{"recommendations":[{"title":"Fargo","year":2014,"reason":"crime anthology"}]}'),
    snapshotFile, tasteFile, historyFile, recsDir, now: NOW,
  });
  await job.run(fakeCtx());

  const row = getWorkItem('tv-rec-random-1', dayKey(NOW));
  assert.ok(row, 'a work_items row exists for tv-rec-random-1 after a real job run(ctx)');
  assert.equal(row?.status, 'success');
  const detail = row?.detail ? JSON.parse(row.detail) as { name?: string; suggestions?: number; path?: string } : null;
  assert.equal(detail?.name, 'tv-rec-random-1 suggestions');
  assert.equal(detail?.suggestions, 1);
  assert.ok(detail?.path, 'detail.path recorded');
  console.log('  ✓ makeBranchJob("tv-rec-random-1").run(ctx) records a work_items row (tv-recs)');
}

console.log('  ✓ branch.ts onBranchWritten-hook regression tests passed');
