// Notify-stage tests — dedup + digest + ignore-to-suppress against the work_items
// ledger. Hermetic: NO live push (an injected capture fn), synthetic franchise-gaps
// file, scratch DB (npm test points LOCALJOBS_DB at /tmp). Covers: first run = one
// digest of the whole backlog; an already-notified gap is NOT re-notified; a freshly
// detected gap aggregates into a new single digest; an owner-IGNORED gap is excluded
// from BOTH the report AND notifications.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorkItem, ignoreSurfacedItem, isWorkItemDone } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { NOTIFY_JOB, buildDigest, gapKey, runNotify } from './notify.js';
import { RECS_JOB, recKey } from '../recs.js';
import type { FranchiseGap, FranchiseGapsFile, Recommendation, RecommendationsFile, RecsHistoryFile } from '../types.js';

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

// ── buildDigest aggregates count + caps the body ──
const gap = (tmdbId: number, title: string, collectionName = 'Coll'): FranchiseGap =>
  ({ collectionId: 1, collectionName, tmdbId, title, year: 2020, tmdbRating: 6 });
const digest = buildDigest([gap(1, 'A'), gap(2, 'B')]);
assert.equal(digest.count, 2);
assert.match(digest.title, /2 franchise gaps detected/);
assert.match(digest.body, /A/);
assert.match(digest.body, /B/);
assert.equal(buildDigest([gap(3, 'Solo')]).title, '🎬 1 franchise gap detected', 'singular');
console.log('  ✓ buildDigest aggregates and pluralises');

// Distinct tmdbIds so this test is independent of any other ledger rows.
const SAW_X = 9990010;
const TOY5 = 9990011;
const IGNORED = 9990012;

const dir = mkdtempSync(join(tmpdir(), 'movies-notify-'));
const gapsFile = join(dir, 'gaps.json');
const reportDir = dir;
const reportPath = join(dir, 'franchise-gaps.md');
// Isolate the recs side so these GAPS-only tests don't read the real production
// recommendations/history files (which would make the digest recs-aware and the
// counts machine-dependent). Non-existent paths → runNotify sees zero recs.
const noRecsFile = join(dir, 'no-recs.json');
const noHistoryFile = join(dir, 'no-history.json');
const NOW = new Date('2026-06-24T00:00:00Z');

// Owned example for the Saw Collection (Saw, 2004).
const SAW_EXAMPLES: FranchiseGapsFile['collectionExamples'] = {
  'Saw Collection': { title: 'Saw', year: 2004 },
};

function writeGaps(gaps: FranchiseGap[], collectionExamples: FranchiseGapsFile['collectionExamples'] = SAW_EXAMPLES) {
  const file: FranchiseGapsFile = { generatedAt: NOW.toISOString(), collectionsChecked: gaps.length, gaps, collectionExamples };
  writeFileSync(gapsFile, JSON.stringify(file));
}

const backlog: FranchiseGap[] = [
  { collectionId: 656, collectionName: 'Saw Collection', tmdbId: SAW_X, title: 'Saw X', year: 2023, tmdbRating: 7.3 },
  { collectionId: 87, collectionName: 'Toy Story Collection', tmdbId: TOY5, title: 'Toy Story 5', year: 2026, tmdbRating: 6.5 },
];

// Run 1 — first run sends ONE digest of the whole backlog and marks the ledger.
{
  const sent: CapturedPush[] = [];
  writeGaps(backlog);
  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, gapsFile, recsFile: noRecsFile, historyFile: noHistoryFile, reportDir });
  assert.equal(sent.length, 1, 'first run sends exactly ONE digest');
  assert.match(sent[0].title, /2 franchise gaps detected/);
  assert.match(sent[0].body, /Saw X/);
  assert.match(sent[0].body, /Toy Story 5/);
  assert.ok(isWorkItemDone(NOTIFY_JOB, gapKey(SAW_X), 1));
  assert.ok(isWorkItemDone(NOTIFY_JOB, gapKey(TOY5), 1));
  // The ledger's `detail` is enriched with the actual finding, not just identity.
  const sawRow = getWorkItem(NOTIFY_JOB, gapKey(SAW_X));
  const sawDetail = JSON.parse(sawRow?.detail ?? '{}');
  assert.equal(sawDetail.title, 'Saw X');
  assert.equal(sawDetail.year, 2023);
  assert.equal(sawDetail.collectionId, 656);
  assert.equal(sawDetail.collectionName, 'Saw Collection');
  assert.equal(sawDetail.tmdbRating, 7.3);
  assert.equal(sawDetail.markdown, reportPath);
  console.log('  ✓ gap ledger detail carries the actual finding (title/year/collection/rating)');
  // Report lists both, grouped by collection, with TMDB links + ratings + owned example.
  const md = readFileSync(reportPath, 'utf8');
  assert.match(md, /## Saw Collection/);
  assert.match(md, /\[Saw X\]\(https:\/\/www\.themoviedb\.org\/movie\/9990010\)/);
  assert.match(md, /TMDB 7\.3/);
  assert.match(md, /You own: Saw \(2004\)/, 'owned example anchor appears in the report');
  console.log('  ✓ first run digests the whole backlog, marks the ledger, writes a grouped report');
}

// Run 2 — same backlog, nothing new → NO push.
{
  const sent: CapturedPush[] = [];
  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, gapsFile, recsFile: noRecsFile, historyFile: noHistoryFile, reportDir });
  assert.equal(sent.length, 0, 'a re-run with no new gaps sends nothing (dedup)');
  console.log('  ✓ re-run with nothing new sends no push (dedup)');
}

// Run 3 — a NEW gap appears; only it is notified, in one digest.
{
  const sent: CapturedPush[] = [];
  const grown = [...backlog, { collectionId: 9, collectionName: 'Jurassic Park Collection', tmdbId: 9990013, title: 'Jurassic World Rebirth', year: 2025, tmdbRating: 6.8 }];
  writeGaps(grown);
  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, gapsFile, recsFile: noRecsFile, historyFile: noHistoryFile, reportDir });
  assert.equal(sent.length, 1, 'one digest for the new gap');
  assert.match(sent[0].title, /1 franchise gap detected/);
  assert.match(sent[0].body, /Jurassic World Rebirth/);
  assert.doesNotMatch(sent[0].body, /Saw X/, 'already-notified Saw X is not repeated');
  console.log('  ✓ a newly-detected gap notifies once, not the already-known ones');
}

// Run 4 — ignore-to-suppress. A NEW gap is added then the owner IGNORES it BEFORE
// it's notified: it must be excluded from BOTH the digest AND the report.
{
  const sent: CapturedPush[] = [];
  const withIgnored = [
    ...backlog,
    { collectionId: 9, collectionName: 'Jurassic Park Collection', tmdbId: 9990013, title: 'Jurassic World Rebirth', year: 2025, tmdbRating: 6.8 },
    { collectionId: 12, collectionName: 'Ghostbusters Collection', tmdbId: IGNORED, title: 'Ghostbusters: Frozen Empire', year: 2024, tmdbRating: 6.2 },
  ];
  writeGaps(withIgnored);
  // Owner ignores the Ghostbusters gap.
  ignoreSurfacedItem(NOTIFY_JOB, gapKey(IGNORED));
  assert.ok(isWorkItemDone(NOTIFY_JOB, gapKey(IGNORED), 1), 'ignored gap counts as done');

  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, gapsFile, recsFile: noRecsFile, historyFile: noHistoryFile, reportDir });
  assert.equal(sent.length, 0, 'the only candidate was ignored → no push');
  const md = readFileSync(reportPath, 'utf8');
  assert.doesNotMatch(md, /Ghostbusters/, 'ignored gap is excluded from the report');
  assert.doesNotMatch(md, /Frozen Empire/);
  console.log('  ✓ ignore-to-suppress excludes a gap from BOTH report and notifications');
}

// Run 5 — ignoring an ALREADY-notified gap also removes it from future reports.
{
  const sent: CapturedPush[] = [];
  ignoreSurfacedItem(NOTIFY_JOB, gapKey(SAW_X)); // was notified in run 1
  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, gapsFile, recsFile: noRecsFile, historyFile: noHistoryFile, reportDir });
  assert.equal(sent.length, 0);
  const md = readFileSync(reportPath, 'utf8');
  assert.doesNotMatch(md, /Saw X/, 'a previously-notified gap, once ignored, leaves the report');
  console.log('  ✓ ignoring a previously-notified gap removes it from the report');
}

// ── Recommendation layer (T146): combined digest, recs report section, ignore ──

// buildDigest combines gaps + recs, and is recs-aware in its title.
{
  const rec = (id: number, title: string): Recommendation =>
    ({ tmdbId: id, title, year: 2001, reason: 'great', lens: 'serendipity', genre: 'Drama', tmdbRating: 7 });
  const both = buildDigest([gap(1, 'GapFilm')], [rec(2, 'RecFilm'), rec(3, 'RecTwo')]);
  assert.match(both.title, /1 franchise gap/);
  assert.match(both.title, /2 recommendation/);
  assert.match(both.body, /GapFilm/);
  assert.match(both.body, /RecFilm/);
  const recsOnly = buildDigest([], [rec(4, 'Solo')]);
  assert.equal(recsOnly.title, '🍿 1 film recommendation', 'recs-only digest title');
  console.log('  ✓ buildDigest combines gaps + recs and titles recs-only/both');
}

const REC_A = 7770001;
const REC_B = 7770002;
const REC_IGN = 7770003;

const rdir = mkdtempSync(join(tmpdir(), 'movies-recs-notify-'));
const rGapsFile = join(rdir, 'gaps.json');
const rRecsFile = join(rdir, 'recs.json');
const rHistory = join(rdir, 'history.json');
const rReportPath = join(rdir, 'franchise-gaps.md');
// Empty gaps so the digest is recommendations-only (isolated from the gaps tests).
writeFileSync(rGapsFile, JSON.stringify({ generatedAt: NOW.toISOString(), collectionsChecked: 0, gaps: [] } as FranchiseGapsFile));

const rec = (id: number, title: string, genre: string): Recommendation =>
  ({ tmdbId: id, title, year: 1979, reason: `pick ${title}`, lens: 'world-cinema', genre, tmdbRating: 8.1 });
function writeRecs(recs: Recommendation[]) {
  writeFileSync(rRecsFile, JSON.stringify({ generatedAt: NOW.toISOString(), pooled: recs.length, recommendations: recs } as RecommendationsFile));
}

// Run R1 — first recs run sends ONE digest, writes the report section, marks the
// ledger, and appends history.
{
  const sent: CapturedPush[] = [];
  writeRecs([rec(REC_A, 'Stalker', 'Science Fiction'), rec(REC_B, 'Ran', 'Drama')]);
  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, gapsFile: rGapsFile, recsFile: rRecsFile, historyFile: rHistory, reportDir: rdir });
  assert.equal(sent.length, 1, 'one combined digest');
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
  console.log('  ✓ recs: first run digests, writes the Recommendations section, marks ledger + history');
}

// Run R2 — nothing new → no push (dedup per recommended tmdb id).
{
  const sent: CapturedPush[] = [];
  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, gapsFile: rGapsFile, recsFile: rRecsFile, historyFile: rHistory, reportDir: rdir });
  assert.equal(sent.length, 0, 'already-recommended films are not re-recommended');
  console.log('  ✓ recs: a re-run never re-recommends (dedup per tmdb id)');
}

// Run R3 — ignore-to-suppress a recommendation: a NEW rec is ignored before notify →
// excluded from BOTH the digest AND the report.
{
  const sent: CapturedPush[] = [];
  writeRecs([rec(REC_A, 'Stalker', 'Science Fiction'), rec(REC_B, 'Ran', 'Drama'), rec(REC_IGN, 'Solaris', 'Science Fiction')]);
  ignoreSurfacedItem(RECS_JOB, recKey(REC_IGN));
  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, gapsFile: rGapsFile, recsFile: rRecsFile, historyFile: rHistory, reportDir: rdir });
  assert.equal(sent.length, 0, 'the only new rec was ignored → no push');
  const md = readFileSync(rReportPath, 'utf8');
  assert.doesNotMatch(md, /Solaris/, 'an ignored recommendation is excluded from the report');
  console.log('  ✓ recs: ignore-to-suppress excludes a recommendation from report + notifications');
}

// Run F1 — a FAILED digest push must not poison the ledger: `runNotify` throws,
// no ledger rows are written for the new gap/rec, and history is not appended,
// so the next run retries fresh.
{
  const FAIL_GAP = 9990099;
  const FAIL_REC = 7770099;
  const failGapsFile = join(dir, 'fail-gaps.json');
  const failRecsFile = join(dir, 'fail-recs.json');
  const failHistoryFile = join(dir, 'fail-history.json');
  const failReportDir = mkdtempSync(join(tmpdir(), 'movies-notify-fail-'));
  writeFileSync(failGapsFile, JSON.stringify({
    generatedAt: NOW.toISOString(),
    collectionsChecked: 1,
    gaps: [{ collectionId: 99, collectionName: 'Fail Collection', tmdbId: FAIL_GAP, title: 'Fail Film', year: 2022, tmdbRating: 6 }],
  } as FranchiseGapsFile));
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
      gapsFile: failGapsFile,
      recsFile: failRecsFile,
      historyFile: failHistoryFile,
      reportDir: failReportDir,
    }),
    'runNotify throws when the digest push fails',
  );
  assert.ok(!isWorkItemDone(NOTIFY_JOB, gapKey(FAIL_GAP), 1), 'gap NOT marked notified after a failed push');
  assert.ok(!isWorkItemDone(RECS_JOB, recKey(FAIL_REC), 1), 'rec NOT marked notified after a failed push');
  assert.ok(!existsSync(failHistoryFile), 'history file not written after a failed push');
  console.log('  ✓ a failed digest push throws and leaves the ledger/history untouched (retry next run)');
}

console.log('  ✓ movies notify dedup/digest/ignore tests passed');
