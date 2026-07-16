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
import { moviesConfig } from '../../workflows/movies/config.js';
import type { MovieSnapshotFile, TasteProfileFile } from '../../workflows/movies/types.js';
import { makeBranchJob as makeTvBranchJob } from '../../workflows/tv-recs/stages/recommend.js';
import type { TvSnapshotFile, TvTasteProfileFile } from '../../workflows/tv-recs/types.js';
import { primaryGenre, stratifiedSample } from './pure.js';

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

// ── T615: input-sample rows capture the EXACT items a branch's build() put
// into its prompt — the real lens-filtered subset (targeted) or seeded
// stratified sample (random) — NOT a recomputed/re-sampled reconstruction
// (the T601 bug this re-attempts). Covers one targeted branch (rec-auteur)
// AND one random branch (rec-random-1), asserting the recorded input-sample
// ledger set is byte-for-byte identical to what actually landed in the prompt.
{
  const dir = mkdtempSync(join(tmpdir(), 'movies-input-sample-'));
  const snapshotFile = join(dir, 'snapshot.json');
  const tasteFile = join(dir, 'taste.json');
  const historyFile = join(dir, 'history.json');
  const recsDir = dir;

  const movies: MovieSnapshotFile['movies'] = [
    { title: 'Inception', year: 2010, tmdbId: 1, ratingKey: 'r1', genres: ['Sci-Fi'], directors: ['Christopher Nolan'], countries: ['United States'], audienceRating: 8, rating: 8 },
    { title: 'Dunkirk', year: 2017, tmdbId: 2, ratingKey: 'r2', genres: ['War'], directors: ['Christopher Nolan'], countries: ['United States'], audienceRating: 8, rating: 8 },
    { title: 'Interstellar', year: 2014, tmdbId: 3, ratingKey: 'r3', genres: ['Sci-Fi'], directors: ['Christopher Nolan'], countries: ['United States'], audienceRating: 9, rating: 9 },
    { title: 'Heat', year: 1995, tmdbId: 4, ratingKey: 'r4', genres: ['Crime'], directors: ['Michael Mann'], countries: ['United States'], audienceRating: 8, rating: 8 },
  ];
  const snap: MovieSnapshotFile = { generatedAt: NOW.toISOString(), section: '4', movies };
  writeFileSync(snapshotFile, JSON.stringify(snap));
  const taste: TasteProfileFile = {
    generatedAt: NOW.toISOString(),
    profile: {
      totalMovies: movies.length, withTmdbId: movies.length,
      genres: { 'Sci-Fi': 2, War: 1, Crime: 1 },
      directors: { 'Christopher Nolan': 3, 'Michael Mann': 1 },
      decades: { '1990s': 1, '2010s': 3 },
      countries: { 'United States': 4 },
    },
  };
  writeFileSync(tasteFile, JSON.stringify(taste));
  writeFileSync(historyFile, JSON.stringify({ recommended: [] }));

  // ── Targeted branch: rec-auteur (lens-filtered subset — films by qualifying directors) ──
  let capturedAuteurPrompt = '';
  const auteurJob = makeMovieBranchJob('rec-auteur', {
    runClaude: async (p) => { capturedAuteurPrompt = p; return { ok: true, text: '{"recommendations":[]}', rateLimited: false }; },
    snapshotFile, tasteFile, historyFile, recsDir, now: NOW,
  });
  await auteurJob.run(fakeCtx());

  const dayKeyStr = dayKey(NOW);
  // Nolan owns 3 films (qualifies ≥3) → Inception/Dunkirk/Interstellar are the lens subset;
  // Michael Mann owns only 1 (Heat) → does NOT qualify and must be excluded entirely.
  const expectedAuteurIds = ['r1', 'r2', 'r3'];
  const auteurInputRows = [];
  for (let i = 0; i < 5; i++) {
    const row = getWorkItem('rec-auteur', `${dayKeyStr}::input::${i}`);
    if (row) auteurInputRows.push(row);
  }
  assert.equal(auteurInputRows.length, expectedAuteurIds.length, 'rec-auteur recorded exactly one input-sample row per lens-filtered item — not a differently-sized reconstruction');
  const auteurRecordedIds = auteurInputRows.map((r) => {
    const detail = JSON.parse(r.detail ?? 'null') as { kind?: string; id?: string; title?: string };
    assert.equal(detail.kind, 'input-sample', 'row is marked detail.kind = "input-sample"');
    assert.ok(capturedAuteurPrompt.includes(detail.title ?? '__missing__'), `recorded input-sample title "${detail.title}" appears verbatim in the built prompt`);
    return detail.id;
  }).sort();
  assert.deepEqual(auteurRecordedIds, [...expectedAuteurIds].sort(), 'rec-auteur input-sample ids EXACTLY equal the lens-filtered subset it actually built — not a re-sampled reconstruction');
  assert.ok(!capturedAuteurPrompt.includes('Heat'), 'non-qualifying-director film excluded from both the prompt and the input-sample set');
  console.log('  ✓ rec-auteur (targeted) input-sample rows EXACTLY match the lens-filtered subset build() put in the prompt (T615)');

  // ── Random branch: rec-random-1 (seed = 1000 + 1, stratified by primary genre) ──
  const randomJob = makeMovieBranchJob('rec-random-1', {
    runClaude: ok('{"recommendations":[]}'),
    snapshotFile, tasteFile, historyFile, recsDir, now: NOW,
  });
  await randomJob.run(fakeCtx());

  const expectedSample = stratifiedSample(movies, { keyFn: primaryGenre, target: moviesConfig.recsSampleSize, seed: 1001 });
  const randomInputRows = [];
  for (let i = 0; i < movies.length + 1; i++) {
    const row = getWorkItem('rec-random-1', `${dayKeyStr}::input::${i}`);
    if (row) randomInputRows.push(row);
  }
  assert.equal(randomInputRows.length, expectedSample.length, 'rec-random-1 recorded exactly one input-sample row per seed=1000+n stratified-sample item');
  const randomRecordedIds = randomInputRows.map((r) => (JSON.parse(r.detail ?? 'null') as { id?: string }).id);
  assert.deepEqual(
    randomRecordedIds,
    expectedSample.map((m) => m.ratingKey),
    'rec-random-1 input-sample ids EXACTLY equal (in order) its own seed=1000+n stratified sample — not a differently-seeded/-algorithm reconstruction',
  );
  console.log('  ✓ rec-random-1 (random) input-sample rows EXACTLY match its seed=1000+n stratified sample (T615)');
}

console.log('  ✓ branch.ts onBranchWritten-hook + per-suggestion-ledger tests passed');
