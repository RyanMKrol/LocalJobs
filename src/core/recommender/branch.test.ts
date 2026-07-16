// T599/T600: regression test for the `recordBranchLedgerRow` shadowing bug —
// T599 fixed the hook so it actually fires from the REAL job execution path.
// T600 changed it from one per-branch row to one per-suggestion row.
// This drives `makeBranchJob(id, runOpts).run(ctx)` end-to-end (an injected
// `runClaude` — no live Claude call) for BOTH movies and tv-recs, and asserts
// `work_items` rows now exist for the branch's job name, each keyed by
// `dayKey::index` with per-suggestion detail (title, year, reason, lens).
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
    runClaude: ok('{"recommendations":[{"title":"Stalker","year":1979,"reason":"a meditative sci-fi","lens":"serendipity"}]}'),
    snapshotFile, tasteFile, historyFile, recsDir, now: NOW,
  });
  await job.run(fakeCtx());

  // T600: per-suggestion ledger rows, keyed by dayKey::index
  const dayKeyStr = dayKey(NOW);
  const row = getWorkItem('rec-random-1', `${dayKeyStr}::0`);
  assert.ok(row, 'a work_items row exists for rec-random-1 after a real job run(ctx)');
  assert.equal(row?.status, 'success');
  const detail = row?.detail ? JSON.parse(row.detail) as { title?: string; year?: number; reason?: string; lens?: string } : null;
  assert.equal(detail?.title, 'Stalker', 'detail.title recorded');
  assert.equal(detail?.year, 1979, 'detail.year recorded');
  assert.equal(detail?.reason, 'a meditative sci-fi', 'detail.reason recorded');
  assert.equal(detail?.lens, 'serendipity', 'detail.lens recorded');
  console.log('  ✓ makeBranchJob("rec-random-1").run(ctx) records per-suggestion work_items rows (movies, T600)');
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
    runClaude: ok('{"recommendations":[{"title":"Fargo","year":2014,"reason":"crime anthology","lens":"serendipity"}]}'),
    snapshotFile, tasteFile, historyFile, recsDir, now: NOW,
  });
  await job.run(fakeCtx());

  // T600: per-suggestion ledger rows, keyed by dayKey::index
  const dayKeyStr = dayKey(NOW);
  const row = getWorkItem('tv-rec-random-1', `${dayKeyStr}::0`);
  assert.ok(row, 'a work_items row exists for tv-rec-random-1 after a real job run(ctx)');
  assert.equal(row?.status, 'success');
  const detail = row?.detail ? JSON.parse(row.detail) as { title?: string; year?: number; reason?: string; lens?: string } : null;
  assert.equal(detail?.title, 'Fargo', 'detail.title recorded');
  assert.equal(detail?.year, 2014, 'detail.year recorded');
  assert.equal(detail?.reason, 'crime anthology', 'detail.reason recorded');
  assert.equal(detail?.lens, 'serendipity', 'detail.lens recorded');
  console.log('  ✓ makeBranchJob("tv-rec-random-1").run(ctx) records per-suggestion work_items rows (tv-recs, T600)');
}

console.log('  ✓ branch.ts onBranchWritten-hook + per-suggestion-ledger tests passed');
