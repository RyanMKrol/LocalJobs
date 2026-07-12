// Notify-stage tests — dedup + digest + ignore-to-suppress against the work_items
// ledger. Hermetic: NO live push (an injected capture fn), synthetic franchise-gaps
// file in a tmpdir, scratch DB (npm test points LOCALJOBS_DB at /tmp). Covers: first
// run = one digest of the whole backlog; an already-notified gap is NOT re-notified;
// a freshly detected gap aggregates into a new single digest; an owner-IGNORED gap
// is excluded from BOTH the report AND notifications.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorkItem, ignoreSurfacedItem, isWorkItemDone } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { NOTIFY_JOB, buildDigest, gapKey, runNotify } from './notify.js';
import type { FranchiseGap, FranchiseGapsFile } from '../../movies/types.js';

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

const dir = mkdtempSync(join(tmpdir(), 'missing-movies-notify-'));
const gapsFile = join(dir, 'gaps.json');
const reportDir = dir;
const reportPath = join(dir, 'franchise-gaps.md');
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
  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, gapsFile, reportDir });
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
  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, gapsFile, reportDir });
  assert.equal(sent.length, 0, 'a re-run with no new gaps sends nothing (dedup)');
  console.log('  ✓ re-run with nothing new sends no push (dedup)');
}

// Run 3 — a NEW gap appears; only it is notified, in one digest.
{
  const sent: CapturedPush[] = [];
  const grown = [...backlog, { collectionId: 9, collectionName: 'Jurassic Park Collection', tmdbId: 9990013, title: 'Jurassic World Rebirth', year: 2025, tmdbRating: 6.8 }];
  writeGaps(grown);
  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, gapsFile, reportDir });
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

  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, gapsFile, reportDir });
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
  await runNotify(fakeCtx(), { push: capturePush(sent), now: NOW, gapsFile, reportDir });
  assert.equal(sent.length, 0);
  const md = readFileSync(reportPath, 'utf8');
  assert.doesNotMatch(md, /Saw X/, 'a previously-notified gap, once ignored, leaves the report');
  console.log('  ✓ ignoring a previously-notified gap removes it from the report');
}

// Run F1 — a FAILED digest push must not poison the ledger: `runNotify` throws,
// no ledger row is written for the new gap, so the next run retries fresh.
{
  const FAIL_GAP = 9990099;
  const failGapsFile = join(dir, 'fail-gaps.json');
  const failReportDir = mkdtempSync(join(tmpdir(), 'missing-movies-notify-fail-'));
  writeFileSync(failGapsFile, JSON.stringify({
    generatedAt: NOW.toISOString(),
    collectionsChecked: 1,
    gaps: [{ collectionId: 99, collectionName: 'Fail Collection', tmdbId: FAIL_GAP, title: 'Fail Film', year: 2022, tmdbRating: 6 }],
  } as FranchiseGapsFile));

  const failingPush = (async () => ({ ok: false, error: 'network down' })) as unknown as typeof import('../../../core/notifier.js').push;

  await assert.rejects(
    () => runNotify(fakeCtx(), {
      push: failingPush,
      now: NOW,
      gapsFile: failGapsFile,
      reportDir: failReportDir,
    }),
    'runNotify throws when the digest push fails',
  );
  assert.ok(!isWorkItemDone(NOTIFY_JOB, gapKey(FAIL_GAP), 1), 'gap NOT marked notified after a failed push');
  assert.ok(existsSync(join(failReportDir, 'franchise-gaps.md')), 'report is still (re)written even on a failed push');
  console.log('  ✓ a failed digest push throws and leaves the ledger untouched (retry next run)');
}

console.log('  ✓ missing-movies notify dedup/digest/ignore tests passed');
