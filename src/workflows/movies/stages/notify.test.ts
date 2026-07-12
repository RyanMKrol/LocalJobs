// Notify-stage tests (T468 split — recs-only; the franchise-gaps half moved to
// missing-movies/stages/notify.test.ts) — dedup + digest + ignore-to-suppress
// against the work_items ledger. Hermetic: NO live push (an injected capture
// fn), synthetic recommendations file, scratch DB (npm test points LOCALJOBS_DB
// at /tmp). Covers: first run = one digest of the whole backlog; an
// already-notified rec is NOT re-notified; a freshly detected rec aggregates
// into a new single digest; an owner-IGNORED rec is excluded from BOTH the
// report AND notifications; a failed push leaves the ledger/history untouched.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorkItem, ignoreSurfacedItem, isWorkItemDone } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { NOTIFY_JOB, buildDigest, gapKey, runNotify } from './notify.js';
import { RECS_JOB, recKey } from '../recs.js';
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

// The gaps-ledger compat re-export (kept for src/api/server.ts's existing
// import path — see notify.ts's top-of-file comment) is present but UNUSED by
// this file's own recs-only logic; a sanity check pins that it still exists
// with its historical value so a future edit can't silently drop it and break
// server.ts's import.
assert.equal(NOTIFY_JOB, 'movie-gaps-notify', 'NOTIFY_JOB compat re-export keeps its historical value');
assert.equal(gapKey(42), '42', 'gapKey compat re-export still works');
console.log('  ✓ NOTIFY_JOB/gapKey compat re-export (for src/api/server.ts) is intact');

// ── buildDigest is recs-only now ──
const rec = (id: number, title: string, genre = 'Drama'): Recommendation =>
  ({ tmdbId: id, title, year: 2001, reason: 'great', lens: 'serendipity', genre, tmdbRating: 7 });
{
  const digest = buildDigest([rec(1, 'A'), rec(2, 'B')]);
  assert.equal(digest.count, 2);
  assert.match(digest.title, /2 film recommendations/);
  assert.match(digest.body, /A/);
  assert.match(digest.body, /B/);
  assert.equal(buildDigest([rec(3, 'Solo')]).title, '🍿 1 film recommendation', 'singular');
  console.log('  ✓ buildDigest aggregates and pluralises (recs-only)');
}

const REC_A = 7770101;
const REC_B = 7770102;
const REC_IGN = 7770103;

const dir = mkdtempSync(join(tmpdir(), 'movies-recs-notify-'));
const recsFile = join(dir, 'recs.json');
const historyFile = join(dir, 'history.json');
const reportDir = dir;
const reportPath = join(dir, 'recommendations.md');
const NOW = new Date('2026-06-24T00:00:00Z');

function writeRecs(recs: Recommendation[]) {
  writeFileSync(recsFile, JSON.stringify({ generatedAt: NOW.toISOString(), pooled: recs.length, recommendations: recs } as RecommendationsFile));
}

// Run 1 — first run sends ONE digest of the whole backlog and marks the ledger.
{
  const sent: CapturedPush[] = [];
  writeRecs([rec(REC_A, 'Stalker', 'Science Fiction'), rec(REC_B, 'Ran', 'Drama')]);
  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, recsFile, historyFile, reportDir });
  assert.equal(sent.length, 1, 'first run sends exactly ONE digest');
  assert.match(sent[0].title, /2 film recommendations/);
  assert.match(sent[0].body, /Stalker/);
  assert.match(sent[0].body, /Ran/);
  assert.ok(isWorkItemDone(RECS_JOB, recKey(REC_A), 1));
  assert.ok(isWorkItemDone(RECS_JOB, recKey(REC_B), 1));
  // The ledger's `detail` is enriched with the actual finding, not just identity.
  const row = getWorkItem(RECS_JOB, recKey(REC_A));
  const detail = JSON.parse(row?.detail ?? '{}');
  assert.equal(detail.title, 'Stalker');
  assert.equal(detail.year, 2001);
  assert.equal(detail.lens, 'serendipity');
  assert.equal(detail.genre, 'Science Fiction');
  assert.equal(detail.reason, 'great');
  assert.equal(detail.tmdbRating, 7);
  assert.equal(detail.markdown, reportPath);
  console.log('  ✓ rec ledger detail carries the actual finding (lens/genre/reason/rating)');
  const md = readFileSync(reportPath, 'utf8');
  assert.match(md, /## Recommendations/);
  assert.match(md, /\[Stalker\]\(https:\/\/www\.themoviedb\.org\/movie\/7770101\)/, 'rec has a TMDB link');
  assert.match(md, /serendipity/, 'rec shows its lens');
  const hist = JSON.parse(readFileSync(historyFile, 'utf8')) as RecsHistoryFile;
  assert.equal(hist.recommended.length, 2, 'both recs appended to history');
  console.log('  ✓ first run digests the whole backlog, marks the ledger, writes the report + history');
}

// Run 2 — same backlog, nothing new → NO push (dedup per recommended tmdb id).
{
  const sent: CapturedPush[] = [];
  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, recsFile, historyFile, reportDir });
  assert.equal(sent.length, 0, 'a re-run with no new recs sends nothing (dedup)');
  console.log('  ✓ re-run with nothing new sends no push (dedup)');
}

// Run 3 — a NEW rec appears; only it is notified, in one digest.
{
  const sent: CapturedPush[] = [];
  writeRecs([rec(REC_A, 'Stalker', 'Science Fiction'), rec(REC_B, 'Ran', 'Drama'), rec(9990201, 'Solaris', 'Science Fiction')]);
  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, recsFile, historyFile, reportDir });
  assert.equal(sent.length, 1, 'one digest for the new rec');
  assert.match(sent[0].title, /1 film recommendation/);
  assert.match(sent[0].body, /Solaris/);
  assert.doesNotMatch(sent[0].body, /Stalker/, 'already-notified Stalker is not repeated');
  console.log('  ✓ a newly-detected rec notifies once, not the already-known ones');
}

// Run 4 — ignore-to-suppress. A NEW rec is ignored BEFORE it's notified: it
// must be excluded from BOTH the digest AND the report.
{
  const sent: CapturedPush[] = [];
  writeRecs([
    rec(REC_A, 'Stalker', 'Science Fiction'),
    rec(REC_B, 'Ran', 'Drama'),
    rec(9990201, 'Solaris', 'Science Fiction'),
    rec(REC_IGN, 'Redacted', 'Drama'),
  ]);
  ignoreSurfacedItem(RECS_JOB, recKey(REC_IGN));
  assert.ok(isWorkItemDone(RECS_JOB, recKey(REC_IGN), 1), 'ignored rec counts as done');

  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, recsFile, historyFile, reportDir });
  assert.equal(sent.length, 0, 'the only candidate was ignored → no push');
  const md = readFileSync(reportPath, 'utf8');
  assert.doesNotMatch(md, /Redacted/, 'ignored rec is excluded from the report');
  console.log('  ✓ ignore-to-suppress excludes a rec from BOTH report and notifications');
}

// Run F1 — a FAILED digest push must not poison the ledger: `runNotify` throws,
// no ledger row is written for the new rec, and history is not appended, so the
// next run retries fresh.
{
  const FAIL_REC = 7770199;
  const failRecsFile = join(dir, 'fail-recs.json');
  const failHistoryFile = join(dir, 'fail-history.json');
  const failReportDir = mkdtempSync(join(tmpdir(), 'movies-recs-notify-fail-'));
  writeFileSync(failRecsFile, JSON.stringify({
    generatedAt: NOW.toISOString(),
    pooled: 1,
    recommendations: [{ tmdbId: FAIL_REC, title: 'Fail Rec', year: 2001, reason: 'x', lens: 'serendipity', genre: 'Drama', tmdbRating: 7 }],
  } as RecommendationsFile));

  const failingPush = (async () => ({ ok: false, error: 'network down' })) as unknown as typeof import('../../../core/notifier.js').push;

  await assert.rejects(
    () => runNotify(fakeCtx(), {
      push: failingPush,
      now: NOW,
      recsFile: failRecsFile,
      historyFile: failHistoryFile,
      reportDir: failReportDir,
    }),
    'runNotify throws when the digest push fails',
  );
  assert.ok(!isWorkItemDone(RECS_JOB, recKey(FAIL_REC), 1), 'rec NOT marked notified after a failed push');
  assert.ok(!existsSync(failHistoryFile), 'history file not written after a failed push');
  console.log('  ✓ a failed digest push throws and leaves the ledger/history untouched (retry next run)');
}

console.log('  ✓ movies recs-notify dedup/digest/ignore tests passed');
