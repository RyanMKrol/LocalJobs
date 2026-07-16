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

// ── T600: recordBranchLedgerRow records ONE row per suggestion (not one per branch) ──
{
  const { makeBranchJob } = await import('./recommend.js');
  const dirT600A = mkdtempSync(join(tmpdir(), 'tv-recs-t600-'));
  const snapshotT600A = join(dirT600A, 'snapshot.json');
  const tasteT600A = join(dirT600A, 'taste.json');
  const historyT600A = join(dirT600A, 'history.json');
  const recsDirT600A = dirT600A;

  const snapT600A: TvSnapshotFile = {
    generatedAt: NOW.toISOString(), section: '5',
    shows: [
      { title: 'Breaking Bad', year: 2008, tmdbId: 1396, ratingKey: '1', genres: ['Drama'], roles: [], countries: ['United States'], studio: 'AMC', audienceRating: 9, rating: 9, seasonCount: 5 },
    ],
  };
  writeFileSync(snapshotT600A, JSON.stringify(snapT600A));

  const tasteT600AProfile: TvTasteProfileFile = {
    generatedAt: NOW.toISOString(),
    profile: { totalShows: 1, withTmdbId: 1, genres: { Drama: 1 }, roles: {}, decades: { '2000s': 1 }, countries: { 'United States': 1 } },
  };
  writeFileSync(tasteT600A, JSON.stringify(tasteT600AProfile));
  writeFileSync(historyT600A, JSON.stringify({ recommended: [] }));

  // Job def with onBranchWritten that records ledger rows
  const jobDef = makeBranchJob('tv-rec-random-1', {
    runClaude: ok('{"recommendations":[{"title":"True Detective","year":2014,"reason":"detective noir","lens":"serendipity"},{"title":"Fargo","year":2014,"reason":"dark humor","lens":"serendipity"},{"title":"The Sopranos","year":1999,"reason":"groundbreaking","lens":"serendipity"}]}'),
    snapshotFile: snapshotT600A,
    tasteFile: tasteT600A,
    historyFile: historyT600A,
    recsDir: recsDirT600A,
    now: NOW,
  });

  await jobDef.run(fakeCtx());

  // Query the ledger for rows recorded by this branch — keys are dayKey::index
  const dayKeyStr = dayKey(NOW);
  const t600Rows: WorkItemRow[] = [];
  for (let i = 0; i < 5; i++) {
    const row = getWorkItem('tv-rec-random-1', `${dayKeyStr}::${i}`);
    if (row) t600Rows.push(row);
  }

  assert.equal(t600Rows.length, 3, '3 suggestions → 3 ledger rows');

  for (let i = 0; i < t600Rows.length; i++) {
    const row: WorkItemRow = t600Rows[i];
    assert.equal(row.status, 'success');
    const detail = JSON.parse(row.detail ?? 'null') as { title?: string; year?: number; reason?: string; lens?: string };
    assert.ok(detail.title, `row ${i} has a title`);
    assert.ok(typeof detail.year === 'number' || detail.year === null, `row ${i} has a valid year`);
    assert.ok(typeof detail.reason === 'string', `row ${i} has a reason`);
    assert.ok(typeof detail.lens === 'string', `row ${i} has a lens`);
  }

  const detail0 = JSON.parse(t600Rows[0].detail ?? 'null') as { title?: string; year?: number; reason?: string; lens?: string };
  assert.equal(detail0.title, 'True Detective', 'first row detail contains title');
  assert.equal(detail0.year, 2014, 'first row detail contains year');
  assert.equal(detail0.reason, 'detective noir', 'first row detail contains reason');
  assert.equal(detail0.lens, 'serendipity', 'first row detail contains lens');

  const detail1 = JSON.parse(t600Rows[1].detail ?? 'null') as { title?: string };
  assert.equal(detail1.title, 'Fargo', 'second row detail contains title');

  const detail2 = JSON.parse(t600Rows[2].detail ?? 'null') as { title?: string };
  assert.equal(detail2.title, 'The Sopranos', 'third row detail contains title');

  console.log('  ✓ recordBranchLedgerRow records ONE row per suggestion with full detail fields (T600)');
}

// ── T600: zero suggestions → zero ledger rows (skip/error case) ──
{
  const dirT600Zero = mkdtempSync(join(tmpdir(), 'tv-recs-t600-zero-'));
  const snapshotT600Zero = join(dirT600Zero, 'snapshot.json');
  const tasteT600Zero2 = join(dirT600Zero, 'taste.json');
  const historyT600Zero = join(dirT600Zero, 'history.json');
  const recsDirT600Zero = dirT600Zero;

  const snapT600Zero: TvSnapshotFile = {
    generatedAt: NOW.toISOString(), section: '5',
    shows: [{ title: 'S', year: 2000, tmdbId: 1, ratingKey: '1', genres: [], roles: [], countries: ['US'], studio: null, audienceRating: 8, rating: 8, seasonCount: 1 }],
  };
  writeFileSync(snapshotT600Zero, JSON.stringify(snapT600Zero));
  writeFileSync(tasteT600Zero2, JSON.stringify({ generatedAt: NOW.toISOString(), profile: { totalShows: 1, withTmdbId: 1, genres: {}, roles: {}, decades: {}, countries: {} } }));
  writeFileSync(historyT600Zero, JSON.stringify({ recommended: [] }));

  // Error case: Claude failure → zero suggestions
  const { makeBranchJob } = await import('./recommend.js');
  const jobDefZero = makeBranchJob('tv-rec-random-2', {
    runClaude: async () => ({ ok: false, text: '', rateLimited: true, error: 'usage limit' }),
    snapshotFile: snapshotT600Zero,
    tasteFile: tasteT600Zero2,
    historyFile: historyT600Zero,
    recsDir: recsDirT600Zero,
    now: NOW,
  });

  await jobDefZero.run(fakeCtx());

  const dayKeyStr = dayKey(NOW);
  let foundAnyZeroRows = false;
  for (let i = 0; i < 5; i++) {
    if (getWorkItem('tv-rec-random-2', `${dayKeyStr}::${i}`)) {
      foundAnyZeroRows = true;
      break;
    }
  }
  assert.equal(foundAnyZeroRows, false, 'error/skip case records zero ledger rows, not a placeholder');
  console.log('  ✓ recordBranchLedgerRow records zero rows on error/skip (not crash, not placeholder row)');
}

console.log('  ✓ tv-recs branch-runner tests passed');
