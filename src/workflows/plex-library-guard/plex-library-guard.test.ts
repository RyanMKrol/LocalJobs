// Pure-logic tests for the Plex library guard: NO live Plex. Synthetic fixtures
// exercise the part-key fallback chain, snapshot building (per-file entries,
// totals, episode title formatting), the run-over-run diff (missing / added /
// drop threshold), the suspect-partial-read guard, the combined alert push
// builder, and snapshot-file reading.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALERT_LIST_CAP,
  buildAlertPush,
  buildSnapshot,
  diffSnapshots,
  episodeEntries,
  formatBytes,
  isSuspectRead,
  movieEntries,
  partKey,
  readSnapshot,
  SUSPECT_MIN_PREV_FILES,
  SUSPECT_MISSING_RATIO,
} from './lib.js';
import type { GuardEpisodeMeta, GuardMovieMeta, LibrarySnapshotFile } from './types.js';

const GB = 1024 ** 3;
const now = new Date('2026-08-09T10:30:00Z');

// ── partKey: id → file → index fallback chain ──
assert.equal(partKey('m1', { id: 101, file: '/x.mkv', size: 1 }, 0), 'm1::101', 'part id wins when present');
assert.equal(partKey('m1', { file: '/x.mkv', size: 1 }, 0), 'm1::/x.mkv', 'file path is the fallback');
assert.equal(partKey('m1', { size: 1 }, 3), 'm1::#3', 'index is the last resort');
console.log('  ✓ partKey: id → file → index fallback chain');

// ── movieEntries: one entry per Part, title carries the year ──
const movies: GuardMovieMeta[] = [
  { title: 'Heat', year: 1995, ratingKey: 'm1', Media: [{ Part: [{ id: 11, file: '/movies/heat-pt1.mkv', size: 5 * GB }, { id: 12, file: '/movies/heat-pt2.mkv', size: 5 * GB }] }] },
  { title: 'Small Movie', ratingKey: 'm2', Media: [{ Part: [{ id: 21, file: '/movies/small.mkv', size: 2 * GB }] }] },
];
const mEntries = movieEntries(movies);
assert.equal(mEntries.length, 3, 'a 2-part movie yields 2 entries');
assert.equal(mEntries[0].title, 'Heat (1995)');
assert.equal(mEntries[2].title, 'Small Movie', 'no year, no parenthetical');
assert.equal(mEntries[0].key, 'm1::11');
assert.equal(mEntries[0].file, '/movies/heat-pt1.mkv');
assert.equal(mEntries[0].type, 'movie');
console.log('  ✓ movieEntries: one entry per Part');

// ── episodeEntries: SxxExx title formatting ──
const episodes: GuardEpisodeMeta[] = [
  { title: 'The Buys', grandparentTitle: 'The Wire', parentIndex: 1, index: 3, ratingKey: 'e1', Media: [{ Part: [{ id: 31, file: '/tv/wire-s01e03.mkv', size: 1 * GB }] }] },
  { title: 'Pilot', grandparentTitle: 'Some Show', parentIndex: 10, index: 12, ratingKey: 'e2', Media: [{ Part: [{ id: 41, size: 1 * GB }] }] },
];
const eEntries = episodeEntries(episodes);
assert.equal(eEntries[0].title, 'The Wire — S01E03 — The Buys');
assert.equal(eEntries[1].title, 'Some Show — S10E12 — Pilot', 'two-digit season/episode stay unpadded-correct');
assert.equal(eEntries[1].file, null, 'a part with no file path records null');
console.log('  ✓ episodeEntries: SxxExx title formatting, null file handled');

// ── buildSnapshot: totals + counts ──
const snap = buildSnapshot(movies, episodes, '4', '5', now);
assert.equal(snap.fileCount, 5);
assert.equal(snap.totalBytes, 14 * GB);
assert.equal(snap.totalHuman, formatBytes(14 * GB));
assert.equal(snap.generatedAt, now.toISOString());
console.log('  ✓ buildSnapshot: totals, counts, timestamp');

// ── diffSnapshots: missing / added / drop math ──
const prevSnap = buildSnapshot(movies, episodes, '4', '5', new Date('2026-08-08T10:30:00Z'));
{
  // Delete one movie part + one episode from the current scan.
  const currentSnap = buildSnapshot(
    [movies[0] && { ...movies[0], Media: [{ Part: [{ id: 11, file: '/movies/heat-pt1.mkv', size: 5 * GB }] }] }, movies[1]] as GuardMovieMeta[],
    [episodes[0]],
    '4',
    '5',
    now,
  );
  const diff = diffSnapshots(prevSnap, currentSnap, 0);
  assert.equal(diff.missing.length, 2, 'one movie part + one episode missing');
  assert.deepEqual(diff.missing.map((f) => f.key).sort(), ['e2::41', 'm1::12']);
  assert.equal(diff.dropBytes, 6 * GB);
  assert.equal(diff.dropExceeds, true, 'threshold 0: any drop exceeds');
  assert.equal(diff.addedCount, 0);
}
{
  // Growth + a new file: nothing missing, nothing exceeds.
  const grown = buildSnapshot(
    [...movies, { title: 'New Movie', year: 2026, ratingKey: 'm3', Media: [{ Part: [{ id: 51, file: '/movies/new.mkv', size: 9 * GB }] }] }],
    episodes,
    '4',
    '5',
    now,
  );
  const diff = diffSnapshots(prevSnap, grown, 0);
  assert.equal(diff.missing.length, 0);
  assert.equal(diff.addedCount, 1);
  assert.ok(diff.dropBytes < 0);
  assert.equal(diff.dropExceeds, false, 'a growing library never exceeds');
}
{
  // Threshold semantics: at exactly the threshold, no alert; a byte past it, alert.
  const shrunkBy1Gb = { ...prevSnap, totalBytes: prevSnap.totalBytes - 1 * GB, files: prevSnap.files };
  assert.equal(diffSnapshots(prevSnap, shrunkBy1Gb, 1).dropExceeds, false, 'exactly at threshold does not exceed');
  const shrunkPastIt = { ...prevSnap, totalBytes: prevSnap.totalBytes - 1 * GB - 1, files: prevSnap.files };
  assert.equal(diffSnapshots(prevSnap, shrunkPastIt, 1).dropExceeds, true, 'one byte past threshold exceeds');
  const shrunkBy1Byte = { ...prevSnap, totalBytes: prevSnap.totalBytes - 1, files: prevSnap.files };
  assert.equal(diffSnapshots(prevSnap, shrunkBy1Byte, 0).dropExceeds, true, 'threshold 0: a 1-byte drop alerts');
}
console.log('  ✓ diffSnapshots: missing/added detection + drop threshold semantics');

// ── isSuspectRead boundaries ──
assert.equal(isSuspectRead(100, 51), true, '51% of 100 files missing is suspect');
assert.equal(isSuspectRead(100, 50), false, 'exactly the ratio is not suspect');
assert.equal(isSuspectRead(SUSPECT_MIN_PREV_FILES - 1, SUSPECT_MIN_PREV_FILES - 1), false, 'small libraries never trip the ratio guard');
assert.equal(isSuspectRead(SUSPECT_MIN_PREV_FILES, SUSPECT_MIN_PREV_FILES), true, 'at the floor, all-missing is suspect');
assert.ok(SUSPECT_MISSING_RATIO > 0 && SUSPECT_MISSING_RATIO < 1);
console.log('  ✓ isSuspectRead: ratio + small-library floor boundaries');

// ── buildAlertPush ──
{
  const nothing = buildAlertPush({ dropBytes: -5, dropExceeds: false, missing: [], addedCount: 2 }, prevSnap, snap);
  assert.equal(nothing, null, 'stable/growing with nothing missing builds no push');

  const dropOnly = buildAlertPush({ dropBytes: 3 * GB, dropExceeds: true, missing: [], addedCount: 0 }, prevSnap, snap);
  assert.ok(dropOnly);
  assert.match(dropOnly.title, /-3\.0 GB/);
  assert.ok(!dropOnly.title.includes('missing'), 'drop-only title names no missing files');

  const missingOnly = buildAlertPush({ dropBytes: 0, dropExceeds: false, missing: [prevSnap.files[0]], addedCount: 0 }, prevSnap, snap);
  assert.ok(missingOnly);
  assert.match(missingOnly.title, /1 file\(s\) missing/);
  assert.ok(missingOnly.body.includes('Heat (1995)'), 'body names the missing title');
  assert.ok(missingOnly.body.includes('/movies/heat-pt1.mkv'), 'body names the missing path');

  const manyMissing = buildAlertPush(
    {
      dropBytes: 30 * GB,
      dropExceeds: true,
      missing: Array.from({ length: ALERT_LIST_CAP + 5 }, (_, i) => ({ key: `k${i}`, ratingKey: `r${i}`, type: 'movie' as const, title: `Movie ${i}`, file: null, bytes: GB })),
      addedCount: 0,
    },
    prevSnap,
    snap,
  );
  assert.ok(manyMissing);
  assert.match(manyMissing.title, /25 file\(s\) missing, -30\.0 GB/, 'combined title carries both signals');
  assert.ok(manyMissing.body.includes(`…and 5 more`), 'body caps the named list');
  assert.equal(manyMissing.body.split('\n').filter((l) => l.startsWith('•')).length, ALERT_LIST_CAP);
}
console.log('  ✓ buildAlertPush: null when clean, names items, caps the list, combines signals');

// ── readSnapshot: absent → null, garbage → null, valid → parsed ──
{
  const dir = mkdtempSync(join(tmpdir(), 'plex-guard-test-'));
  assert.equal(readSnapshot(join(dir, 'nope.json')), null, 'absent file reads null');
  const garbagePath = join(dir, 'garbage.json');
  writeFileSync(garbagePath, 'not json at all {');
  assert.equal(readSnapshot(garbagePath), null, 'unparseable file reads null');
  const wrongShapePath = join(dir, 'wrong.json');
  writeFileSync(wrongShapePath, JSON.stringify({ hello: 'world' }));
  assert.equal(readSnapshot(wrongShapePath), null, 'wrong-shape file reads null');
  const goodPath = join(dir, 'good.json');
  writeFileSync(goodPath, JSON.stringify(snap satisfies LibrarySnapshotFile));
  const back = readSnapshot(goodPath);
  assert.ok(back);
  assert.equal(back.fileCount, snap.fileCount);
  assert.equal(back.generatedAt, snap.generatedAt);
}
console.log('  ✓ readSnapshot: validating reader');

console.log('  ✓ plex-library-guard pure-logic tests passed');
