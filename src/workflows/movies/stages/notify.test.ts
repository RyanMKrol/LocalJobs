// Notify-stage tests (recs-only, T468) — dedup + digest + ignore-to-suppress
// against the work_items ledger. Hermetic: NO live push (an injected capture fn),
// synthetic recommendations file, scratch DB (npm test points LOCALJOBS_DB at
// /tmp). Covers: first run = one digest of the whole pool; an already-notified
// rec is NOT re-recommended; a freshly-recommended film aggregates into a new
// single digest; an owner-IGNORED rec is excluded from BOTH the report AND
// notifications.
//
// (The franchise-gap-audit half of these tests moved to
// `src/workflows/missing-movies/stages/notify.test.ts` along with the audit
// itself — T468.)
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorkItem, ignoreSurfacedItem, isWorkItemDone } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { buildDigest, runNotify } from './notify.js';
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

// ── buildDigest aggregates count + pluralises + caps the body ──
{
  const rec = (id: number, title: string): Recommendation =>
    ({ tmdbId: id, title, year: 2001, reason: 'great', lens: 'serendipity', genre: 'Drama', tmdbRating: 7 });
  const both = buildDigest([rec(2, 'RecFilm'), rec(3, 'RecTwo')]);
  assert.equal(both.count, 2);
  assert.match(both.title, /2 film recommendations/);
  assert.match(both.body, /RecFilm/);
  assert.match(both.body, /RecTwo/);
  const solo = buildDigest([rec(4, 'Solo')]);
  assert.equal(solo.title, '🍿 1 film recommendation', 'singular');
  console.log('  ✓ buildDigest aggregates and pluralises');
}

const REC_A = 7770001;
const REC_B = 7770002;
const REC_IGN = 7770003;

const rdir = mkdtempSync(join(tmpdir(), 'movies-recs-notify-'));
const rRecsFile = join(rdir, 'recs.json');
const rHistory = join(rdir, 'history.json');
const rReportPath = join(rdir, 'recommendations.md');

const rec = (id: number, title: string, genre: string): Recommendation =>
  ({ tmdbId: id, title, year: 1979, reason: `pick ${title}`, lens: 'world-cinema', genre, tmdbRating: 8.1 });
function writeRecs(recs: Recommendation[]) {
  writeFileSync(rRecsFile, JSON.stringify({ generatedAt: '2026-06-24T00:00:00Z', pooled: recs.length, recommendations: recs } as RecommendationsFile));
}

const NOW = new Date('2026-06-24T00:00:00Z');

// Run R1 — first recs run sends ONE digest, writes the report section, marks the
// ledger, and appends history.
{
  const sent: CapturedPush[] = [];
  writeRecs([rec(REC_A, 'Stalker', 'Science Fiction'), rec(REC_B, 'Ran', 'Drama')]);
  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, recsFile: rRecsFile, historyFile: rHistory, reportDir: rdir });
  assert.equal(sent.length, 1, 'one digest');
  assert.match(sent[0].title, /2 film recommendations/);
  assert.match(sent[0].body, /Stalker/);
  assert.ok(isWorkItemDone(RECS_JOB, recKey(REC_A), 1), 'rec marked in the recs ledger');
  // The rec ledger's `detail` is enriched with the actual finding, including the reason.
  const stalkerRow = getWorkItem(RECS_JOB, recKey(REC_A));
  const stalkerDetail = JSON.parse(stalkerRow?.detail ?? '{}');
  assert.equal(stalkerDetail.title, 'Stalker');
  assert.equal(stalkerDetail.year, 1979);
  assert.equal(stalkerDetail.lens, 'world-cinema');
  assert.equal(stalkerDetail.genre, 'Science Fiction');
  assert.equal(stalkerDetail.reason, 'pick Stalker');
  assert.equal(stalkerDetail.tmdbRating, 8.1);
  assert.equal(stalkerDetail.markdown, rReportPath);
  console.log('  ✓ rec ledger detail carries the actual finding (lens/genre/reason/rating)');
  const md = readFileSync(rReportPath, 'utf8');
  assert.match(md, /## Recommendations/);
  assert.match(md, /\[Stalker\]\(https:\/\/www\.themoviedb\.org\/movie\/7770001\)/, 'rec has a TMDB link');
  assert.match(md, /world-cinema/, 'rec shows its lens');
  assert.match(md, /pick Stalker/, 'rec shows its reason');
  const hist = JSON.parse(readFileSync(rHistory, 'utf8')) as RecsHistoryFile;
  assert.equal(hist.recommended.length, 2, 'both recs appended to history');
  console.log('  ✓ first run digests, writes the Recommendations report, marks ledger + history');
}

// Run R2 — nothing new → no push (dedup per recommended tmdb id).
{
  const sent: CapturedPush[] = [];
  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, recsFile: rRecsFile, historyFile: rHistory, reportDir: rdir });
  assert.equal(sent.length, 0, 'already-recommended films are not re-recommended');
  console.log('  ✓ a re-run never re-recommends (dedup per tmdb id)');
}

// Run R3 — ignore-to-suppress a recommendation: a NEW rec is ignored before notify →
// excluded from BOTH the digest AND the report.
{
  const sent: CapturedPush[] = [];
  writeRecs([rec(REC_A, 'Stalker', 'Science Fiction'), rec(REC_B, 'Ran', 'Drama'), rec(REC_IGN, 'Solaris', 'Science Fiction')]);
  ignoreSurfacedItem(RECS_JOB, recKey(REC_IGN));
  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, recsFile: rRecsFile, historyFile: rHistory, reportDir: rdir });
  assert.equal(sent.length, 0, 'the only new rec was ignored → no push');
  const md = readFileSync(rReportPath, 'utf8');
  assert.doesNotMatch(md, /Solaris/, 'an ignored recommendation is excluded from the report');
  console.log('  ✓ ignore-to-suppress excludes a recommendation from report + notifications');
}

// Run R4 — a FAILED digest push must not poison the ledger: `runNotify` throws,
// no ledger row is written for the new rec, and history is not appended, so the
// next run retries fresh.
{
  const FAIL_REC = 7770099;
  const failRecsFile = join(rdir, 'fail-recs.json');
  const failHistoryFile = join(rdir, 'fail-history.json');
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
