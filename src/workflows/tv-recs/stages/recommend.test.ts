// TV-recs branch-runner tests — hermetic: NO live Claude (injected runClaude),
// synthetic snapshot + taste profile, temp recs dir. Covers: valid reply → suggestions;
// error → empty file + error, NO throw; T600: per-suggestion ledger rows instead of per-branch.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobContext } from '../../../core/types.js';
import type { ClaudeResult } from '../../../services/claude.js';
import { dayKey } from '../../../core/dates.js';
import { getWorkItem } from '../../../db/store.js';
import type { WorkItemRow } from '../../../db/store.js';
import { branchById } from './branches.js';
import { parseSuggestions, runBranch } from './recommend.js';
import type { BranchOutputFile, TvSnapshotFile, TvTasteProfileFile, RecsHistoryFile } from '../types.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}
const NOW = new Date('2026-06-24T00:00:00Z');
const ok = (text: string): (() => Promise<ClaudeResult>) => async () => ({ ok: true, text, rateLimited: false });

// ── parseSuggestions: valid object → suggestions; junk → throws ──
{
  const parsed = parseSuggestions('{"recommendations":[{"title":"Dark","year":2017,"reason":"mind-bending thriller"},{"title":"Incomplete"}]}', 'creator');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, 'Dark');
  assert.equal(parsed[0].year, 2017);
  assert.equal(parsed[0].lens, 'creator');
  assert.equal(parsed[1].year, null, 'a missing year → null');
  assert.throws(() => parseSuggestions('No JSON here.', 'x'), 'no JSON → throws');
  console.log('  ✓ parseSuggestions parses a valid object and rejects junk');
}

// Shared fixtures: a snapshot + taste profile on disk.
const dir = mkdtempSync(join(tmpdir(), 'tv-recs-branch-'));
const snapshotFile = join(dir, 'snapshot.json');
const tasteFile = join(dir, 'taste.json');
const historyFile = join(dir, 'history.json');
const recsDir = dir;

const snap: TvSnapshotFile = {
  generatedAt: NOW.toISOString(), section: '5',
  shows: [
    { title: 'Breaking Bad', year: 2008, tmdbId: 1396, ratingKey: '1', genres: ['Drama', 'Crime'], roles: ['Aaron Paul'], countries: ['United States'], studio: 'AMC', audienceRating: 9, rating: 9, seasonCount: 5 },
    { title: 'The Office', year: 2005, tmdbId: 2316, ratingKey: '2', genres: ['Comedy'], roles: ['Steve Carell'], countries: ['United States'], studio: 'NBC', audienceRating: 8, rating: 8, seasonCount: 9 },
  ],
};
writeFileSync(snapshotFile, JSON.stringify(snap));

const tasteWithCreator: TvTasteProfileFile = {
  generatedAt: NOW.toISOString(),
  profile: {
    totalShows: 2, withTmdbId: 2,
    genres: { Drama: 1, Crime: 1, Comedy: 1 },
    roles: { 'Vince Gilligan': 4 }, // qualifies creator (≥3)
    decades: { '2000s': 2 }, countries: { 'United States': 2 },
  },
};
writeFileSync(tasteFile, JSON.stringify(tasteWithCreator));

const readBranch = (id: string): BranchOutputFile =>
  JSON.parse(readFileSync(join(recsDir, `${id}.json`), 'utf8')) as BranchOutputFile;

// ── valid reply → suggestions written ──
{
  const spec = branchById('tv-rec-random-1');
  await runBranch(fakeCtx(), spec, {
    runClaude: ok('{"recommendations":[{"title":"Succession","year":2018,"reason":"prestige drama"}]}'),
    snapshotFile, tasteFile, historyFile, recsDir, now: NOW,
  });
  const file = readBranch('tv-rec-random-1');
  assert.equal(file.suggestions.length, 1);
  assert.equal(file.suggestions[0].title, 'Succession');
  assert.equal(file.suggestions[0].lens, 'serendipity');
  assert.ok(!file.error);
  console.log('  ✓ runBranch writes parsed suggestions on a valid reply');
}

// ── junk reply → empty + error, NO throw ──
{
  const spec = branchById('tv-rec-random-2');
  await assert.doesNotReject(runBranch(fakeCtx(), spec, {
    runClaude: ok('I cannot provide that JSON.'),
    snapshotFile, tasteFile, historyFile, recsDir, now: NOW,
  }));
  const file = readBranch('tv-rec-random-2');
  assert.equal(file.suggestions.length, 0, 'junk → no suggestions');
  assert.match(file.error ?? '', /unparseable/);
  console.log('  ✓ runBranch handles junk/no-JSON output without failing the run');
}

// ── Claude error (ok:false) → empty + error, NO throw ──
{
  const spec = branchById('tv-rec-random-3');
  await assert.doesNotReject(runBranch(fakeCtx(), spec, {
    runClaude: async () => ({ ok: false, text: '', rateLimited: true, error: 'rate limit' }),
    snapshotFile, tasteFile, historyFile, recsDir, now: NOW,
  }));
  const file = readBranch('tv-rec-random-3');
  assert.equal(file.suggestions.length, 0);
  assert.match(file.error ?? '', /rate\/usage limit/);
  console.log('  ✓ runBranch handles a Claude error/rate-limit gracefully');
}

// (The branch STAGE end to end, what it commits and the sample it reports, is covered
// for both domains in src/core/recommender/branch.test.ts.)

console.log('  ✓ tv-recs branch-runner tests passed');
