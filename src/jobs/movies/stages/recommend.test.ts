// Branch-runner tests — hermetic: NO live Claude (an injected runClaude),
// synthetic snapshot + taste profile, temp recs dir. Covers: a valid reply parses
// into suggestions; a junk/no-JSON reply is handled WITHOUT failing the run (empty
// file + error); a Claude error is handled the same; a branch with nothing to
// target (auteur with no qualifying directors) skips gracefully.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobContext } from '../../../core/types.js';
import type { ClaudeResult } from '../../../services/claude.js';
import { branchById } from './branches.js';
import { parseSuggestions, runBranch } from './recommend.js';
import type { BranchOutputFile, MovieSnapshotFile, TasteProfileFile } from '../types.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}
const NOW = new Date('2026-06-24T00:00:00Z');
const ok = (text: string): (() => Promise<ClaudeResult>) => async () => ({ ok: true, text, rateLimited: false });

// ── parseSuggestions: valid object → suggestions; junk → throws ──
{
  const parsed = parseSuggestions('{"recommendations":[{"title":"Akira","year":1988,"reason":"anime landmark"},{"title":"Blank"}]}', 'world-cinema');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, 'Akira');
  assert.equal(parsed[0].year, 1988);
  assert.equal(parsed[0].lens, 'world-cinema');
  assert.equal(parsed[1].year, null, 'a missing year → null');
  assert.throws(() => parseSuggestions('I cannot help with that.', 'x'), 'no JSON → throws');
  console.log('  ✓ parseSuggestions parses a valid object and rejects junk');
}

// Shared fixtures: a snapshot + taste profile on disk.
const dir = mkdtempSync(join(tmpdir(), 'movies-branch-'));
const snapshotFile = join(dir, 'snapshot.json');
const tasteFile = join(dir, 'taste.json');
const historyFile = join(dir, 'history.json');
const recsDir = dir;

const snap: MovieSnapshotFile = {
  generatedAt: NOW.toISOString(), section: '4',
  movies: [
    { title: 'The Matrix', year: 1999, tmdbId: 603, ratingKey: '1', genres: ['Action', 'Sci-Fi'], directors: ['Lana Wachowski'], countries: ['United States'], audienceRating: 8, rating: 8 },
    { title: 'Heat', year: 1995, tmdbId: 949, ratingKey: '2', genres: ['Crime'], directors: ['Michael Mann'], countries: ['United States'], audienceRating: 8, rating: 8 },
  ],
};
writeFileSync(snapshotFile, JSON.stringify(snap));

const tasteWithAuteur: TasteProfileFile = {
  generatedAt: NOW.toISOString(),
  profile: {
    totalMovies: 2, withTmdbId: 2,
    genres: { Action: 1, 'Sci-Fi': 1, Crime: 1 },
    directors: { 'Christopher Nolan': 4 }, // qualifies auteur (≥3)
    decades: { '1990s': 2 }, countries: { 'United States': 2 },
  },
};
writeFileSync(tasteFile, JSON.stringify(tasteWithAuteur));

const readBranch = (id: string): BranchOutputFile =>
  JSON.parse(readFileSync(join(recsDir, `${id}.json`), 'utf8')) as BranchOutputFile;

// ── valid reply → suggestions written ──
{
  const spec = branchById('rec-random-1');
  await runBranch(fakeCtx(), spec, {
    runClaude: ok('{"recommendations":[{"title":"Stalker","year":1979,"reason":"a meditative sci-fi"}]}'),
    snapshotFile, tasteFile, historyFile, recsDir, now: NOW,
  });
  const file = readBranch('rec-random-1');
  assert.equal(file.suggestions.length, 1);
  assert.equal(file.suggestions[0].title, 'Stalker');
  assert.equal(file.suggestions[0].lens, 'serendipity');
  assert.ok(!file.error);
  console.log('  ✓ runBranch writes parsed suggestions on a valid reply');
}

// ── junk reply → empty + error, NO throw ──
{
  const spec = branchById('rec-random-2');
  await assert.doesNotReject(runBranch(fakeCtx(), spec, {
    runClaude: ok('Sorry, I really cannot produce that JSON.'),
    snapshotFile, tasteFile, historyFile, recsDir, now: NOW,
  }));
  const file = readBranch('rec-random-2');
  assert.equal(file.suggestions.length, 0, 'junk → no suggestions');
  assert.match(file.error ?? '', /unparseable/);
  console.log('  ✓ runBranch handles junk/no-JSON output without failing the run');
}

// ── Claude error (ok:false) → empty + error, NO throw ──
{
  const spec = branchById('rec-random-3');
  await assert.doesNotReject(runBranch(fakeCtx(), spec, {
    runClaude: async () => ({ ok: false, text: '', rateLimited: true, error: 'usage limit' }),
    snapshotFile, tasteFile, historyFile, recsDir, now: NOW,
  }));
  const file = readBranch('rec-random-3');
  assert.equal(file.suggestions.length, 0);
  assert.match(file.error ?? '', /rate\/usage limit/);
  console.log('  ✓ runBranch handles a Claude error/rate-limit gracefully');
}

// ── no-target branch (auteur with no qualifying directors) → skip ──
{
  const noAuteur: TasteProfileFile = {
    generatedAt: NOW.toISOString(),
    profile: { totalMovies: 2, withTmdbId: 2, genres: { Action: 2 }, directors: { Someone: 1 }, decades: { '1990s': 2 }, countries: { 'United States': 2 } },
  };
  const tf = join(dir, 'taste-no-auteur.json');
  writeFileSync(tf, JSON.stringify(noAuteur));
  let claudeCalled = false;
  const spec = branchById('rec-auteur');
  await runBranch(fakeCtx(), spec, {
    runClaude: async () => { claudeCalled = true; return { ok: true, text: '{}', rateLimited: false }; },
    snapshotFile, tasteFile: tf, historyFile, recsDir, now: NOW,
  });
  const file = readBranch('rec-auteur');
  assert.equal(file.suggestions.length, 0);
  assert.match(file.error ?? '', /no targets/);
  assert.equal(claudeCalled, false, 'a no-target branch never calls Claude');
  console.log('  ✓ runBranch skips a branch with nothing to target (no Claude call)');
}

console.log('  ✓ movies branch-runner tests passed');
