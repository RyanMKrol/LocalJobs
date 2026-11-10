// A recommender branch STAGE, driven end to end through `job.run(ctx)` with an
// injected `runClaude` (no live Claude call), for both the movie and the TV domain.
//
// What a branch promises:
//   - it reads the snapshot and the taste profile from its INPUT PORTS
//   - it commits its suggestions file, which describes each suggestion for the run page
//   - it reports the EXACT owned titles it put in its prompt (its real input), via
//     `input.used()`: the lens-filtered subset for a targeted branch, the seeded
//     stratified sample for a random one, never a later reconstruction
//   - it writes NO ledger rows: nothing is recorded just to be visible
//   - a genuine Claude failure fails the stage; a usage limit does not
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeResult } from '../../services/claude.js';
import { workItemCounts } from '../../db/store.js';
import { makeTestContext } from '../../engine/testing/context.js';
import { movieArtifacts } from '../../workflows/movies/contracts.js';
import { makeBranchJob as makeMovieBranchJob } from '../../workflows/movies/stages/recommend.js';
import { moviesConfig } from '../../workflows/movies/config.js';
import type { MovieSnapshotFile, TasteProfileFile } from '../../workflows/movies/types.js';
import { tvArtifacts } from '../../workflows/tv-recs/contracts.js';
import { makeBranchJob as makeTvBranchJob } from '../../workflows/tv-recs/stages/recommend.js';
import type { TvSnapshotFile, TvTasteProfileFile } from '../../workflows/tv-recs/types.js';
import type { JobDefinition } from '../types.js';
import { primaryGenre, stratifiedSample } from './pure.js';
import type { BranchOutputFile } from './types.js';

const NOW = new Date('2026-07-16T00:00:00Z');
const ok = (text: string) => async (): Promise<ClaudeResult> => ({ ok: true, text, rateLimited: false });

/** Run a branch stage with its two inputs coming from fixture files. */
function run(job: JobDefinition, snapshotFile: string, tasteFile: string) {
  const t = makeTestContext(job, { inputs: { snapshot: { location: snapshotFile, from: 'snapshot-stage' }, taste: { location: tasteFile, from: 'snapshot-stage' } } });
  return { t, done: job.run(t.ctx) };
}
const readBranchFile = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as BranchOutputFile;

// ── movies: rec-random-1 ──
{
  const dir = mkdtempSync(join(tmpdir(), 'movies-branchjob-'));
  const snapshotFile = join(dir, 'snapshot.json');
  const tasteFile = join(dir, 'taste.json');
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

  // The paths are NOT passed as run options: the stage takes them from its ports.
  const job = makeMovieBranchJob('rec-random-1', {
    runClaude: ok('{"recommendations":[{"title":"Stalker","year":1979,"reason":"a meditative sci-fi","lens":"serendipity"}]}'),
    historyFile: join(dir, 'history.json'), recsDir: dir, now: NOW,
  });
  assert.deepEqual(Object.keys(job.inputs ?? {}), ['snapshot', 'taste']);
  assert.deepEqual(Object.keys(job.outputs ?? {}), ['suggestions']);
  assert.equal(job.outputs!.suggestions.artifact, movieArtifacts.suggestions, 'every branch outputs the SAME artifact type (so the merge can fan them in)');

  const { t, done } = run(job, snapshotFile, tasteFile);
  await done;

  const file = readBranchFile(dir, 'rec-random-1');
  assert.deepEqual(file.suggestions, [{ title: 'Stalker', year: 1979, reason: 'a meditative sci-fi', lens: 'serendipity' }]);
  // How the run page shows that output.
  assert.equal(movieArtifacts.suggestions.check(file).ok, true);
  assert.deepEqual(movieArtifacts.suggestions.items!(file), [
    { id: '0', title: 'Stalker (1979)', subtitle: 'a meditative sci-fi', fields: [{ label: 'Lens', value: 'serendipity' }] },
  ]);
  // Its real input: the one owned film it sampled into the prompt.
  assert.deepEqual(t.used.snapshot, [{ id: '603', title: 'The Matrix (1999)', fields: [{ label: 'TMDB', value: '603' }] }]);
  assert.deepEqual(workItemCounts('rec-random-1'), {}, 'no ledger rows: nothing is recorded just to be visible');
  console.log('  ✓ rec-random-1 reads its ports, commits its suggestions, reports the sample it used (movies)');
}

// ── tv-recs: tv-rec-random-1 ──
{
  const dir = mkdtempSync(join(tmpdir(), 'tv-branchjob-'));
  const snapshotFile = join(dir, 'snapshot.json');
  const tasteFile = join(dir, 'taste.json');
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
    historyFile: join(dir, 'history.json'), recsDir: dir, now: NOW,
  });
  assert.equal(job.outputs!.suggestions.artifact, tvArtifacts.suggestions);
  const { t, done } = run(job, snapshotFile, tasteFile);
  await done;

  assert.deepEqual(readBranchFile(dir, 'tv-rec-random-1').suggestions, [{ title: 'Fargo', year: 2014, reason: 'crime anthology', lens: 'serendipity' }]);
  assert.deepEqual(t.used.snapshot, [{ id: '1438', title: 'The Wire (2002)', fields: [{ label: 'TMDB', value: '1438' }] }]);
  assert.deepEqual(workItemCounts('tv-rec-random-1'), {});
  console.log('  ✓ tv-rec-random-1 reads its ports, commits its suggestions, reports the sample it used (tv-recs)');
}

// ── The reported sample is the EXACT set of items build() put into the prompt:
// the real lens-filtered subset (targeted) or seeded stratified sample (random),
// NOT a recomputed or re-sampled reconstruction. Covers one of each.
{
  const dir = mkdtempSync(join(tmpdir(), 'movies-input-sample-'));
  const snapshotFile = join(dir, 'snapshot.json');
  const tasteFile = join(dir, 'taste.json');
  const historyFile = join(dir, 'history.json');

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

  // Targeted branch: rec-auteur (films by directors the owner has ≥3 of).
  let capturedAuteurPrompt = '';
  const auteurJob = makeMovieBranchJob('rec-auteur', {
    runClaude: async (p) => { capturedAuteurPrompt = p; return { ok: true, text: '{"recommendations":[]}', rateLimited: false }; },
    historyFile, recsDir: dir, now: NOW,
  });
  const auteur = run(auteurJob, snapshotFile, tasteFile);
  await auteur.done;
  // Nolan owns 3 films (qualifies) → Inception/Dunkirk/Interstellar are the lens subset;
  // Michael Mann owns only 1 (Heat) → does NOT qualify and must be excluded entirely.
  assert.deepEqual(
    (auteur.t.used.snapshot ?? []).map((i) => i.id).sort(),
    ['1', '2', '3'],
    'rec-auteur reports EXACTLY the lens-filtered subset it built, not a differently-sized reconstruction',
  );
  for (const item of auteur.t.used.snapshot ?? []) {
    assert.ok(capturedAuteurPrompt.includes(item.title.replace(/ \(\d{4}\)$/, '')), `reported input "${item.title}" appears in the built prompt`);
  }
  assert.ok(!capturedAuteurPrompt.includes('Heat'), 'a non-qualifying director\'s film is in neither the prompt nor the reported sample');
  console.log('  ✓ rec-auteur (targeted) reports exactly the lens-filtered subset build() put in the prompt');

  // Random branch: rec-random-1 (seed = 1000 + 1, stratified by primary genre).
  const randomJob = makeMovieBranchJob('rec-random-1', { runClaude: ok('{"recommendations":[]}'), historyFile, recsDir: dir, now: NOW });
  const random = run(randomJob, snapshotFile, tasteFile);
  await random.done;
  const expectedSample = stratifiedSample(movies, { keyFn: primaryGenre, target: moviesConfig.recsSampleSize, seed: 1001 });
  assert.deepEqual(
    (random.t.used.snapshot ?? []).map((i) => i.id),
    expectedSample.map((m) => String(m.tmdbId)),
    'rec-random-1 reports EXACTLY (in order) its own seed=1000+n stratified sample, not a differently-seeded reconstruction',
  );
  console.log('  ✓ rec-random-1 (random) reports exactly its seed=1000+n stratified sample');
}

// ── A GENUINE Claude failure fails the branch; a rate-limit soft-skips ──
// Regression: a `spawn claude ENOENT` (claude not found) used to be swallowed as a
// soft-skip, so the branch job reported SUCCESS despite producing zero recommendations
// (and the whole workflow "succeeded" with an empty digest). A real error must FAIL the
// run; only a rate/usage limit legitimately defers.
{
  const dir = mkdtempSync(join(tmpdir(), 'movies-branch-fail-'));
  const snapshotFile = join(dir, 'snapshot.json');
  const tasteFile = join(dir, 'taste.json');
  const historyFile = join(dir, 'history.json');
  const snap: MovieSnapshotFile = {
    generatedAt: NOW.toISOString(), section: '4',
    movies: [{ title: 'The Matrix', year: 1999, tmdbId: 603, ratingKey: '1', genres: ['Action'], directors: ['Lana Wachowski'], countries: ['United States'], audienceRating: 8, rating: 8 }],
  };
  writeFileSync(snapshotFile, JSON.stringify(snap));
  const taste: TasteProfileFile = {
    generatedAt: NOW.toISOString(),
    profile: { totalMovies: 1, withTmdbId: 1, genres: { Action: 1 }, directors: {}, decades: { '1990s': 1 }, countries: { 'United States': 1 } },
  };
  writeFileSync(tasteFile, JSON.stringify(taste));

  // Genuine error (ENOENT-style) → the branch stage MUST throw, writing no suggestions file.
  const failJob = makeMovieBranchJob('rec-random-2', {
    runClaude: async (): Promise<ClaudeResult> => ({ ok: false, text: '', rateLimited: false, error: 'Error: spawn claude ENOENT' }),
    historyFile, recsDir: dir, now: NOW,
  });
  await assert.rejects(() => run(failJob, snapshotFile, tasteFile).done, /spawn claude ENOENT/, 'a genuine Claude failure throws (branch run recorded failed, not swallowed)');

  // Rate/usage limit → legitimate defer: resolves normally and still hands over a
  // (valid, empty) suggestions file, so the merge can go ahead with the other branches.
  const rateLimitJob = makeMovieBranchJob('rec-random-3', {
    runClaude: async (): Promise<ClaudeResult> => ({ ok: false, text: '', rateLimited: true, error: 'usage limit reached' }),
    historyFile, recsDir: dir, now: NOW,
  });
  await run(rateLimitJob, snapshotFile, tasteFile).done; // must NOT throw
  const deferred = readBranchFile(dir, 'rec-random-3');
  assert.deepEqual(deferred.suggestions, []);
  assert.equal(movieArtifacts.suggestions.check(deferred).ok, true, 'an empty suggestions file from a deferred branch passes its check');
  assert.match(movieArtifacts.suggestions.summary!(deferred), /0 suggestion\(s\) \[rate\/usage limit\]/, 'and the run page says why it is empty');
  console.log('  ✓ genuine Claude error fails the branch; a rate-limit soft-skips (no false success)');
}

console.log('  ✓ recommender branch stage tests passed');
