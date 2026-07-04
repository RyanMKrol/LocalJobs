// Notify-stage tests — dedup + digest aggregation against the work_items ledger.
// Hermetic: NO live push (an injected capture fn), synthetic missing-seasons file,
// scratch DB (npm test points LOCALJOBS_DB at /tmp). Covers: first run = one digest
// of the whole backlog; a (show, season) already in the ledger is NOT re-notified;
// a freshly-added season aggregates into a new single digest; nothing-new = no push.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isWorkItemDone } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { NOTIFY_JOB, buildDigest, pairKey, runNotify } from './notify.js';
import type { MissingSeasonsFile } from '../types.js';

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

// ── buildDigest aggregates count + body ──
const digest = buildDigest([
  { title: 'Futurama', tmdbId: 615, seasons: [8, 9, 10] },
  { title: 'Bridgerton', tmdbId: 63247, seasons: [4] },
]);
assert.equal(digest.count, 4, 'counts every (show, season) pair');
assert.match(digest.title, /4 new seasons/);
assert.match(digest.body, /Futurama S8–S10/);
assert.match(digest.body, /Bridgerton S4/);
assert.equal(buildDigest([{ title: 'X', tmdbId: 1, seasons: [2] }]).title, '📺 1 new season available', 'singular');
console.log('  ✓ buildDigest aggregates and pluralises');

// Use distinct tmdbIds so this test is independent of any other ledger rows.
const FUTURAMA = 9990615;
const BRIDGERTON = 9963247;

const missingFile = join(mkdtempSync(join(tmpdir(), 'plex-notify-')), 'missing.json');
function writeMissing(file: MissingSeasonsFile) {
  writeFileSync(missingFile, JSON.stringify(file));
}

const NOW = new Date('2026-06-24T00:00:00Z');

const backlog: MissingSeasonsFile = {
  generatedAt: NOW.toISOString(),
  shows: [
    { title: 'Futurama', year: 1999, tmdbId: FUTURAMA, ratingKey: 'f', highestOwnedSeason: 7, tmdbStatus: 'Ended', highestAiredSeason: 9, completeMissingSeasons: [8, 9] },
    { title: 'Bridgerton', year: 2020, tmdbId: BRIDGERTON, ratingKey: 'b', highestOwnedSeason: 3, tmdbStatus: 'Returning Series', highestAiredSeason: 4, completeMissingSeasons: [4] },
  ],
  unverifiable: [],
};

// Run 1 — first run sends ONE digest of the whole backlog and marks the ledger.
{
  const sent: CapturedPush[] = [];
  const push = (async (title: string, body: string) => {
    sent.push({ title, body });
    return { ok: true };
  }) as unknown as typeof import('../../../core/notifier.js').push;
  writeMissing(backlog);
  await runNotify(fakeCtx(), { push, now: NOW, missingFile });
  assert.equal(sent.length, 1, 'first run sends exactly ONE digest');
  assert.equal(sent[0].title, '📺 3 new seasons available', 'digest counts all 3 backlog seasons');
  assert.match(sent[0].body, /Futurama S8–S9/);
  assert.match(sent[0].body, /Bridgerton S4/);
  // Ledger marked for every notified pair.
  assert.ok(isWorkItemDone(NOTIFY_JOB, pairKey(FUTURAMA, 8), 1));
  assert.ok(isWorkItemDone(NOTIFY_JOB, pairKey(FUTURAMA, 9), 1));
  assert.ok(isWorkItemDone(NOTIFY_JOB, pairKey(BRIDGERTON, 4), 1));
  console.log('  ✓ first run digests the whole backlog and marks the ledger');
}

// Run 2 — same backlog, nothing new → NO push sent.
{
  const sent: CapturedPush[] = [];
  const push = (async (title: string, body: string) => {
    sent.push({ title, body });
    return { ok: true };
  }) as unknown as typeof import('../../../core/notifier.js').push;
  await runNotify(fakeCtx(), { push, now: NOW, missingFile });
  assert.equal(sent.length, 0, 'a re-run with no new seasons sends nothing');
  console.log('  ✓ re-run with nothing new sends no push (dedup)');
}

// Run 3 — Futurama gains S10; only the NEW season is notified, in one digest.
{
  const sent: CapturedPush[] = [];
  const push = (async (title: string, body: string) => {
    sent.push({ title, body });
    return { ok: true };
  }) as unknown as typeof import('../../../core/notifier.js').push;
  const grown: MissingSeasonsFile = {
    ...backlog,
    shows: [
      { ...backlog.shows[0], completeMissingSeasons: [8, 9, 10] }, // S10 newly complete
      backlog.shows[1],
    ],
  };
  writeMissing(grown);
  await runNotify(fakeCtx(), { push, now: NOW, missingFile });
  assert.equal(sent.length, 1, 'one digest for the new season');
  assert.equal(sent[0].title, '📺 1 new season available', 'only S10 is new');
  assert.match(sent[0].body, /Futurama S10/);
  assert.doesNotMatch(sent[0].body, /Bridgerton/, 'already-notified Bridgerton S4 is not repeated');
  assert.ok(isWorkItemDone(NOTIFY_JOB, pairKey(FUTURAMA, 10), 1), 'S10 now marked notified');
  console.log('  ✓ a newly-completed season notifies once, not the already-known ones');
}

console.log('  ✓ plex notify dedup/digest tests passed');
