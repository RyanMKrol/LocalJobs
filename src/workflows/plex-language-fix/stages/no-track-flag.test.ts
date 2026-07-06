// No-track-flag stage tests — dedup + digest aggregation against the work_items
// ledger, plus ignore-to-suppress. Hermetic: NO live push (an injected capture
// fn), synthetic language-scan file, scratch DB (npm test points LOCALJOBS_DB at
// /tmp). Covers: a no-match entry not yet in the ledger is newly-detected +
// digested; an already-flagged entry is excluded from the digest but still
// appears in the regenerated report; an ignored entry is excluded from BOTH.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ignoreSurfacedItem, isWorkItemDone } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { plexLanguageFixConfig } from '../config.js';
import { NO_TRACK_JOB, buildDigest, fileKey, runNoTrackFlag } from './no-track-flag.js';
import type { LanguageScanFile } from '../types.js';

function fakeCtx(): JobContext {
  return {
    log() {},
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

interface CapturedPush {
  title: string;
  body: string;
}

// ── buildDigest groups by show/movie and pluralises episode counts ──
const digest = buildDigest([
  { key: 'a::part1', showOrMovieTitle: 'Hunter x Hunter', type: 'show', itemTitle: 'E1', seasonEpisode: 'S01E01' },
  { key: 'a::part2', showOrMovieTitle: 'Hunter x Hunter', type: 'show', itemTitle: 'E2', seasonEpisode: 'S01E02' },
  { key: 'b::part1', showOrMovieTitle: 'Some Movie', type: 'movie', itemTitle: 'Some Movie' },
]);
assert.equal(digest.count, 3);
assert.match(digest.title, /3 files/);
assert.match(digest.body, /Hunter x Hunter \(2 episodes\)/);
assert.match(digest.body, /Some Movie/);
console.log('  ✓ buildDigest groups by show/movie and counts episodes');

// Use distinct rating keys so this test is independent of any other ledger rows.
const HXH_KEY = 'rk-hxh-9990001';
const MOVIE_KEY = 'rk-movie-9990002';

const scanFile = join(mkdtempSync(join(tmpdir(), 'plex-no-track-')), 'scan.json');
function writeScan(file: LanguageScanFile) {
  writeFileSync(scanFile, JSON.stringify(file));
}

const NOW = new Date('2026-07-06T00:00:00Z');

const backlog: LanguageScanFile = {
  generatedAt: NOW.toISOString(),
  sectionsScanned: ['5'],
  items: [
    {
      sectionTitle: 'TV',
      ratingKey: HXH_KEY,
      title: 'Hunter x Hunter',
      type: 'show',
      tmdbId: 46298,
      originalLanguage: 'ja',
      files: [
        {
          itemRatingKey: HXH_KEY,
          itemTitle: 'Episode 1',
          seasonEpisode: 'S01E01',
          partId: 1,
          file: '/media/hxh/s01e01.mkv',
          status: 'no-match',
          currentAudio: { streamId: 10, label: 'English', isExplicit: true },
          currentSubtitle: { streamId: null, label: 'none', isExplicit: false },
          note: 'no audio track found for any candidate language (ja)',
        },
        {
          itemRatingKey: HXH_KEY,
          itemTitle: 'Episode 2',
          seasonEpisode: 'S01E02',
          partId: 2,
          file: '/media/hxh/s01e02.mkv',
          status: 'already-correct',
          currentAudio: { streamId: 11, label: 'Japanese', isExplicit: true },
          currentSubtitle: { streamId: null, label: 'none', isExplicit: false },
        },
      ],
    },
    {
      sectionTitle: 'Movies',
      ratingKey: MOVIE_KEY,
      title: 'Some Movie',
      type: 'movie',
      tmdbId: 555,
      originalLanguage: 'fr',
      files: [
        {
          itemRatingKey: MOVIE_KEY,
          itemTitle: 'Some Movie',
          partId: 1,
          file: '/media/some-movie.mkv',
          status: 'no-match',
          currentAudio: { streamId: 20, label: 'English', isExplicit: true },
          currentSubtitle: { streamId: null, label: 'none', isExplicit: false },
          note: 'no audio track found for any candidate language (fr)',
        },
      ],
    },
  ],
};

// Run 1 — first run sends ONE digest of the whole backlog and marks the ledger.
{
  const sent: CapturedPush[] = [];
  const push = (async (title: string, body: string) => {
    sent.push({ title, body });
    return { ok: true };
  }) as unknown as typeof import('../../../core/notifier.js').push;
  writeScan(backlog);
  await runNoTrackFlag(fakeCtx(), { push, now: NOW, scanFile });
  assert.equal(sent.length, 1, 'first run sends exactly ONE digest');
  assert.equal(sent[0].title, '🌐 2 files with no original-language track');
  assert.match(sent[0].body, /Hunter x Hunter/);
  assert.match(sent[0].body, /Some Movie/);
  assert.ok(isWorkItemDone(NO_TRACK_JOB, fileKey(HXH_KEY, 1), 1));
  assert.ok(isWorkItemDone(NO_TRACK_JOB, fileKey(MOVIE_KEY, 1), 1));
  console.log('  ✓ first run digests the whole backlog and marks the ledger');
}

// Run 2 — same backlog, nothing new → NO push sent, but the report still lists it.
{
  const sent: CapturedPush[] = [];
  const push = (async (title: string, body: string) => {
    sent.push({ title, body });
    return { ok: true };
  }) as unknown as typeof import('../../../core/notifier.js').push;
  await runNoTrackFlag(fakeCtx(), { push, now: NOW, scanFile });
  assert.equal(sent.length, 0, 'a re-run with nothing new sends no push');
  console.log('  ✓ re-run with nothing new sends no push (dedup)');
}

// Run 3 — ignoring the movie's file suppresses it from BOTH the digest and the
// report on a future run (verified by re-running against a fresh backlog entry).
{
  const ignored = ignoreSurfacedItem(NO_TRACK_JOB, fileKey(MOVIE_KEY, 1));
  assert.ok(ignored >= 1, 'ignore updates the existing ledger row');

  // Add a brand-new flagged file so this run has something fresh to digest, and
  // confirm the ignored movie file does not resurface in the digest.
  const SEQUEL_KEY = 'rk-hxh-9990001b';
  const grown: LanguageScanFile = {
    ...backlog,
    items: [
      ...backlog.items,
      {
        sectionTitle: 'TV',
        ratingKey: SEQUEL_KEY,
        title: 'Another Show',
        type: 'show',
        originalLanguage: 'ko',
        files: [
          {
            itemRatingKey: SEQUEL_KEY,
            itemTitle: 'Episode 1',
            seasonEpisode: 'S01E01',
            partId: 1,
            status: 'no-match',
            currentAudio: { streamId: 30, label: 'English', isExplicit: true },
            currentSubtitle: { streamId: null, label: 'none', isExplicit: false },
            note: 'no audio track found for any candidate language (ko)',
          },
        ],
      },
    ],
  };
  writeScan(grown);

  const sent: CapturedPush[] = [];
  const push = (async (title: string, body: string) => {
    sent.push({ title, body });
    return { ok: true };
  }) as unknown as typeof import('../../../core/notifier.js').push;
  await runNoTrackFlag(fakeCtx(), { push, now: NOW, scanFile });
  assert.equal(sent.length, 1, 'one digest for the new show');
  assert.match(sent[0].body, /Another Show/);
  assert.doesNotMatch(sent[0].body, /Some Movie/, 'ignored file is not re-digested');

  const report = readFileSync(join(plexLanguageFixConfig.reportDir, 'no-track.md'), 'utf8');
  assert.match(report, /Hunter x Hunter/, 'previously-flagged (non-ignored) entry still appears in the report');
  assert.doesNotMatch(report, /Some Movie/, 'ignored entry is excluded from the regenerated report');
  console.log('  ✓ ignored entry is excluded from both the digest and the report');
}

// Run 4 — the digest push fails: run() must throw, and the newly-detected file
// should not be marked flagged (so it's retried next run).
{
  const FAIL_KEY = 'rk-failshow-9990099';
  const failBacklog: LanguageScanFile = {
    generatedAt: NOW.toISOString(),
    sectionsScanned: ['5'],
    items: [
      {
        sectionTitle: 'TV',
        ratingKey: FAIL_KEY,
        title: 'PushFail Show',
        type: 'show',
        originalLanguage: 'de',
        files: [
          {
            itemRatingKey: FAIL_KEY,
            itemTitle: 'Episode 1',
            seasonEpisode: 'S01E01',
            partId: 1,
            status: 'no-match',
            currentAudio: { streamId: 40, label: 'English', isExplicit: true },
            currentSubtitle: { streamId: null, label: 'none', isExplicit: false },
            note: 'no audio track found for any candidate language (de)',
          },
        ],
      },
    ],
  };
  const push = (async () => ({ ok: false, error: 'ntfy 500' })) as unknown as typeof import('../../../core/notifier.js').push;
  writeScan(failBacklog);
  await assert.rejects(
    () => runNoTrackFlag(fakeCtx(), { push, now: NOW, scanFile }),
    /Digest push failed/,
    'a failed push rejects the run',
  );
  assert.equal(isWorkItemDone(NO_TRACK_JOB, fileKey(FAIL_KEY, 1), 1), false, 'undelivered file is NOT marked flagged');
  console.log('  ✓ a failed digest push throws and leaves the file un-flagged for retry');
}

console.log('  ✓ plex no-track-flag dedup/digest/ignore tests passed');
