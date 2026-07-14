// tv-recs-notify tests — dedup + digest + ignore-to-suppress against the work_items
// ledger. Hermetic: NO live push (an injected capture fn), synthetic recommendations
// file, scratch DB (npm test points LOCALJOBS_DB at /tmp). Covers: first run = one
// digest of the whole backlog; an already-notified rec is NOT re-notified; a freshly
// detected rec aggregates into a new single digest; an owner-IGNORED rec is excluded
// from BOTH the report AND notifications.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ignoreSurfacedItem, isWorkItemDone } from '../../../db/store.js';
import { db } from '../../../db/index.js';
import type { JobContext } from '../../../core/types.js';
import { RECS_JOB, recKey } from '../recs.js';
import { buildDigest, runTvRecsNotify } from './tv-recs-notify.js';
import type { Recommendation, RecommendationsFile, RecsHistoryFile } from '../types.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

interface CapturedPush { title: string; body: string }
function capturePush(sent: CapturedPush[]) {
  return (async (title: string, body: string) => {
    sent.push({ title, body });
    return { ok: true };
  }) as unknown as typeof import('../../../core/notifier.js').push;
}

const rec = (id: number, title: string, genre = 'Drama'): Recommendation =>
  ({ tmdbId: id, title, year: 2010, reason: `watch ${title}`, lens: 'world-cinema', genre, tmdbRating: 8.0 });

// ── buildDigest ──
{
  const d = buildDigest([rec(1, 'Show A'), rec(2, 'Show B')]);
  assert.equal(d.count, 2);
  assert.match(d.title, /2 TV show recommendations/);
  assert.match(d.body, /Show A/);
  assert.match(d.body, /Show B/);
  assert.equal(buildDigest([rec(3, 'Solo')]).title, '📺 1 TV show recommendation', 'singular');
  console.log('  ✓ buildDigest aggregates and pluralises');
}

// Distinct tmdbIds so this test is isolated from any other ledger rows.
const REC_A = 8880001;
const REC_B = 8880002;
const REC_C = 8880003;
const REC_IGN = 8880004;

const dir = mkdtempSync(join(tmpdir(), 'tv-recs-notify-'));
const recsFile = join(dir, 'recommendations.json');
const historyFile = join(dir, 'history.json');
const reportDir = dir;
const reportPath = join(dir, 'tv-recommendations.md');
const NOW = new Date('2026-06-01T09:00:00Z');

function writeRecs(recs: Recommendation[]) {
  const file: RecommendationsFile = { generatedAt: NOW.toISOString(), pooled: recs.length, recommendations: recs };
  writeFileSync(recsFile, JSON.stringify(file));
}

const backlog: Recommendation[] = [
  rec(REC_A, 'Severance', 'Sci-Fi & Fantasy'),
  rec(REC_B, 'Shogun', 'Drama'),
];

// Run 1 — first run sends ONE digest of the whole backlog and marks the ledger.
{
  const sent: CapturedPush[] = [];
  writeRecs(backlog);
  await runTvRecsNotify(fakeCtx(), { push: capturePush(sent), now: NOW, recsFile, historyFile, reportDir });
  assert.equal(sent.length, 1, 'first run sends exactly ONE digest');
  assert.match(sent[0].title, /2 TV show recommendations/);
  assert.match(sent[0].body, /Severance/);
  assert.match(sent[0].body, /Shogun/);
  assert.ok(isWorkItemDone(RECS_JOB, recKey(REC_A), 1), 'Severance marked in ledger');
  assert.ok(isWorkItemDone(RECS_JOB, recKey(REC_B), 1), 'Shogun marked in ledger');
  const row = db.prepare('SELECT detail FROM work_items WHERE job_name = ? AND item_key = ?')
    .get(RECS_JOB, recKey(REC_A)) as { detail: string | null };
  const detail = JSON.parse(row.detail ?? '{}');
  assert.equal(detail.reason, 'watch Severance', 'detail.reason recorded');
  assert.equal(detail.genre, 'Sci-Fi & Fantasy', 'detail.genre recorded');
  assert.equal(detail.tmdbRating, 8.0, 'detail.tmdbRating recorded');
  assert.equal(detail.lens, 'world-cinema', 'detail.lens recorded');
  assert.equal(detail.tmdbUrl, 'https://www.themoviedb.org/tv/8880001', 'detail.tmdbUrl recorded');
  const md = readFileSync(reportPath, 'utf8');
  assert.match(md, /## Recommendations/);
  assert.match(md, /\[Severance\]\(https:\/\/www\.themoviedb\.org\/tv\/8880001\)/);
  assert.match(md, /TMDB 8\.0/);
  assert.match(md, /world-cinema/, 'lens shown in report');
  assert.match(md, /watch Severance/, 'reason shown in report');
  const hist = JSON.parse(readFileSync(historyFile, 'utf8')) as RecsHistoryFile;
  assert.equal(hist.recommended.length, 2, 'both recs appended to history');
  // T560: history rows are aligned with movies' { tmdbId, title, year, at } shape.
  const sevRow = hist.recommended.find((r) => r.title === 'Severance');
  assert.ok(sevRow, 'Severance row present in history');
  assert.equal(sevRow.tmdbId, REC_A, 'appended history row carries tmdbId');
  assert.equal(sevRow.year, 2010, 'appended history row carries year');
  assert.equal(sevRow.at, NOW.toISOString(), 'appended history row carries an ISO `at` timestamp');
  assert.deepEqual(
    Object.keys(sevRow).sort(),
    ['at', 'title', 'tmdbId', 'year'],
    'appended row is exactly { tmdbId, title, year, at } — matching movies',
  );
  console.log('  ✓ first run digests the whole backlog, marks the ledger, writes the report, appends aligned history');
}

// T560 — a pre-existing LEGACY history file of old {title,year}-only rows must load
// without error and be treated as valid (the corrupt/legacy-tolerant parse stays), then
// new rows append in the aligned shape alongside the legacy ones.
{
  const legacyDir = mkdtempSync(join(tmpdir(), 'tv-recs-notify-legacy-'));
  const legacyRecsFile = join(legacyDir, 'recommendations.json');
  const legacyHistoryFile = join(legacyDir, 'history.json');
  // Old-format history: only title + year, no tmdbId / at.
  writeFileSync(
    legacyHistoryFile,
    JSON.stringify({ recommended: [{ title: 'Old Show', year: 1999 }, { title: 'Another Old', year: 2001 }] }),
  );
  const REC_LEGACY = 8880006;
  const legacyFile: RecommendationsFile = {
    generatedAt: NOW.toISOString(),
    pooled: 1,
    recommendations: [rec(REC_LEGACY, 'Brand New Show', 'Drama')],
  };
  writeFileSync(legacyRecsFile, JSON.stringify(legacyFile));
  const sent: CapturedPush[] = [];
  await assert.doesNotReject(
    runTvRecsNotify(fakeCtx(), { push: capturePush(sent), now: NOW, recsFile: legacyRecsFile, historyFile: legacyHistoryFile, reportDir: legacyDir }),
    'a legacy {title,year}-only history file loads without error',
  );
  const legacyHist = JSON.parse(readFileSync(legacyHistoryFile, 'utf8')) as RecsHistoryFile;
  assert.equal(legacyHist.recommended.length, 3, 'legacy rows preserved + new row appended');
  // Legacy rows survive untouched (no tmdbId/at fabricated).
  const oldRow = legacyHist.recommended.find((r) => r.title === 'Old Show');
  assert.ok(oldRow, 'legacy row still present');
  assert.equal(oldRow.tmdbId, undefined, 'legacy row keeps its 2-field shape');
  assert.equal(oldRow.at, undefined, 'legacy row keeps its 2-field shape');
  // The newly appended row carries the aligned fields.
  const newRow = legacyHist.recommended.find((r) => r.title === 'Brand New Show');
  assert.ok(newRow, 'new row appended to legacy history');
  assert.equal(newRow.tmdbId, REC_LEGACY, 'new row carries tmdbId');
  assert.equal(newRow.at, NOW.toISOString(), 'new row carries at');
  console.log('  ✓ a legacy 2-field history file loads without error; new rows append in the aligned shape');
}

// Run 2 — same backlog, nothing new → NO push.
{
  const sent: CapturedPush[] = [];
  await runTvRecsNotify(fakeCtx(), { push: capturePush(sent), now: NOW, recsFile, historyFile, reportDir });
  assert.equal(sent.length, 0, 're-run with no new recs sends nothing (dedup)');
  console.log('  ✓ re-run with nothing new sends no push (dedup)');
}

// Run 3 — a NEW rec appears; only it is notified, in one digest.
{
  const sent: CapturedPush[] = [];
  const grown = [...backlog, rec(REC_C, 'The Bear', 'Comedy')];
  writeRecs(grown);
  await runTvRecsNotify(fakeCtx(), { push: capturePush(sent), now: NOW, recsFile, historyFile, reportDir });
  assert.equal(sent.length, 1, 'one digest for the new rec');
  assert.match(sent[0].title, /1 TV show recommendation/);
  assert.match(sent[0].body, /The Bear/);
  assert.doesNotMatch(sent[0].body, /Severance/, 'already-notified Severance not repeated');
  assert.ok(isWorkItemDone(RECS_JOB, recKey(REC_C), 1), 'new rec marked in ledger');
  console.log('  ✓ a newly-detected rec notifies once, not the already-known ones');
}

// Run 4 — ignore-to-suppress: a new rec is IGNORED before notify → excluded from
// BOTH the digest AND the report.
{
  const sent: CapturedPush[] = [];
  const withIgnored = [...backlog, rec(REC_IGN, 'The Ignored Show', 'Drama')];
  writeRecs(withIgnored);
  ignoreSurfacedItem(RECS_JOB, recKey(REC_IGN));
  assert.ok(isWorkItemDone(RECS_JOB, recKey(REC_IGN), 1), 'ignored rec counts as done');
  await runTvRecsNotify(fakeCtx(), { push: capturePush(sent), now: NOW, recsFile, historyFile, reportDir });
  assert.equal(sent.length, 0, 'the only new candidate was ignored → no push');
  const md = readFileSync(reportPath, 'utf8');
  assert.doesNotMatch(md, /The Ignored Show/, 'ignored rec excluded from report');
  console.log('  ✓ ignore-to-suppress excludes a rec from BOTH report and notifications');
}

// Run 5 — ignoring an ALREADY-notified rec also removes it from future reports.
{
  const sent: CapturedPush[] = [];
  ignoreSurfacedItem(RECS_JOB, recKey(REC_A)); // was notified in run 1
  await runTvRecsNotify(fakeCtx(), { push: capturePush(sent), now: NOW, recsFile, historyFile, reportDir });
  assert.equal(sent.length, 0);
  const md = readFileSync(reportPath, 'utf8');
  assert.doesNotMatch(md, /Severance/, 'a previously-notified rec, once ignored, leaves the report');
  console.log('  ✓ ignoring a previously-notified rec removes it from the report');
}

// Run 6 — a FAILED digest push must throw BEFORE marking the ledger or appending
// history, so a later run re-sends instead of silently losing the recs.
{
  const REC_FAIL = 8880005;
  const failingPush = (async () => ({ ok: false, error: 'ntfy unreachable' })) as unknown as
    typeof import('../../../core/notifier.js').push;
  const grown = [...backlog, rec(REC_FAIL, 'Failed Push Show', 'Comedy')];
  writeRecs(grown);
  const historyBefore = readFileSync(historyFile, 'utf8');
  await assert.rejects(
    runTvRecsNotify(fakeCtx(), { push: failingPush, now: NOW, recsFile, historyFile, reportDir }),
    /Digest push failed — ntfy unreachable/,
    'a failed digest push throws',
  );
  assert.equal(isWorkItemDone(RECS_JOB, recKey(REC_FAIL), 1), false, 'unnotified rec NOT marked done after a failed push');
  const historyAfter = readFileSync(historyFile, 'utf8');
  assert.equal(historyAfter, historyBefore, 'recs-history.json unchanged after a failed push');
  console.log('  ✓ a failed digest push throws before marking the ledger or appending history');
}

console.log('  ✓ tv-recs-notify dedup/digest/ignore tests passed');
