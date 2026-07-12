// apply.ts tests — against fakes only, never a real Plex server. Sources its
// eligible work from the discover/evaluate ledgers (T453) — there is no more
// data/out/language-scan.json changeset file.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { callService } from '../../../core/services.js';
import type { JobContext } from '../../../core/types.js';
import { getWorkItem, markWorkItem } from '../../../db/store.js';
import type { AppliedLog } from '../types.js';
import type { DiscoverDetail, EvaluateDetail } from '../types.js';
import { JOB_NAME, runApply } from './apply.js';

function fakeCtx(): JobContext {
  return { log() {}, progress() {}, selectedRoots: () => null, rootAllowed: () => true };
}

function seed(itemKey: string, discover: DiscoverDetail, evaluate: EvaluateDetail) {
  markWorkItem('plex-language-discover', itemKey, 'success', { detail: discover });
  markWorkItem('plex-language-evaluate', itemKey, 'success', { detail: evaluate });
}

let tick = 0;
const now = () => new Date(2026, 0, 1, 0, 0, tick++).toISOString();

function latestLog(dir: string): AppliedLog {
  const files = readdirSync(dir).filter((f) => f.startsWith('applied-log-')).sort();
  const last = files[files.length - 1];
  return JSON.parse(readFileSync(join(dir, last), 'utf8')) as AppliedLog;
}

test('a "change" entry with a valid proposed audio streamId is applied and recorded success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plex-language-apply-'));
  const appliedLogPrefix = join(dir, 'applied-log');

  seed(
    'am1::part101',
    { name: 'Amelie', itemRatingKey: 'am1', partId: 101, type: 'movie', tmdbId: 1 },
    {
      name: 'Amelie',
      status: 'change',
      currentAudio: { streamId: 10, label: 'English', isExplicit: true },
      currentSubtitle: { streamId: null, label: 'None', isExplicit: false },
      proposedAudio: { streamId: 11, label: 'French (Original)', isExplicit: false },
      proposedSubtitle: { streamId: 20, label: 'English', isExplicit: false },
    },
  );

  const puts: Array<{ partId: number; audio: number; subtitle: number | null }> = [];
  let backupCalled = false;
  await runApply(fakeCtx(), {
    appliedLogPrefix,
    now,
    putStreams: async (partId, audio, subtitle) => {
      puts.push({ partId, audio, subtitle: subtitle ?? null });
    },
    triggerBackup: async () => {
      backupCalled = true;
      return { ok: true };
    },
  });

  assert.equal(backupCalled, true, 'Butler backup must be triggered before the first real PUT');
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0], { partId: 101, audio: 11, subtitle: 20 });

  const row = getWorkItem(JOB_NAME, 'am1::part101');
  assert.equal(row?.status, 'success');

  const log = latestLog(dir);
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].outcome, 'applied');
  assert.equal(log.entries[0].beforeAudio?.streamId, 10);
  assert.equal(log.entries[0].afterAudio?.streamId, 11);
  assert.equal(log.entries[0].afterSubtitle?.streamId, 20);
  console.log('  ✓ a change entry is applied and recorded success, with before/after in the log');
});

// ── callService('plex', ...) wrapper — pass-through when service unregistered ──
{
  let fnCalled = false;
  const result = await callService('plex', async () => {
    fnCalled = true;
    return { data: 'test' };
  });
  assert.ok(fnCalled, 'callService passes through when plex service is unregistered in tests');
  assert.equal(result.data, 'test', 'result is returned unchanged');
  console.log('  ✓ callService(\'plex\', ...) pass-through wrapper works (unregistered service in test)');
}

test('an entry with a missing proposedAudio.streamId is skipped — not applied, not marked failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plex-language-apply-'));
  const appliedLogPrefix = join(dir, 'applied-log');

  seed(
    'am2::part202',
    { name: 'Malformed Movie', itemRatingKey: 'am2', partId: 202, type: 'movie', tmdbId: 2 },
    {
      name: 'Malformed Movie',
      status: 'change',
      currentAudio: { streamId: 30, label: 'English', isExplicit: true },
      currentSubtitle: { streamId: null, label: 'None', isExplicit: false },
      // proposedAudio deliberately absent
    },
  );

  let putCalled = false;
  await runApply(fakeCtx(), {
    appliedLogPrefix,
    now,
    putStreams: async () => {
      putCalled = true;
    },
    triggerBackup: async () => ({ ok: false, error: 'no changes to apply — backup not triggered' }),
  });

  assert.equal(putCalled, false, 'a malformed entry must never be PUT');
  const row = getWorkItem(JOB_NAME, 'am2::part202');
  assert.equal(row, undefined, 'a skipped malformed entry must not be marked failed (or success)');
  console.log('  ✓ an entry with a missing proposedAudio.streamId is skipped, not applied or marked failed');
});

test('a PUT failure is recorded failed with the error captured, and the run itself throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plex-language-apply-'));
  const appliedLogPrefix = join(dir, 'applied-log');

  seed(
    'am3::part303',
    { name: 'Flaky Movie', itemRatingKey: 'am3', partId: 303, type: 'movie', tmdbId: 3 },
    {
      name: 'Flaky Movie',
      status: 'change',
      currentAudio: { streamId: 40, label: 'English', isExplicit: true },
      currentSubtitle: { streamId: null, label: 'None', isExplicit: false },
      proposedAudio: { streamId: 41, label: 'Spanish (Original)', isExplicit: false },
    },
  );

  await assert.rejects(
    () =>
      runApply(fakeCtx(), {
        appliedLogPrefix,
        now,
        putStreams: async () => {
          throw new Error('Plex HTTP 500');
        },
        triggerBackup: async () => ({ ok: true }),
      }),
    /1\/1 file\(s\) failed to apply/,
  );

  const row = getWorkItem(JOB_NAME, 'am3::part303');
  assert.equal(row?.status, 'failed');
  assert.ok(row?.detail?.includes('Plex HTTP 500'));

  const log = latestLog(dir);
  assert.equal(log.entries[0].outcome, 'failed');
  assert.equal(log.entries[0].error, 'Plex HTTP 500');
  console.log('  ✓ a PUT failure is recorded failed with the error captured, and the run throws');
});

test('a file already applied by a prior run is never re-touched, even if evaluate later re-flags it "change"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plex-language-apply-'));
  const appliedLogPrefix = join(dir, 'applied-log');

  const itemKey = 'am4::part404';
  seed(
    itemKey,
    { name: 'Persepolis', itemRatingKey: 'am4', partId: 404, type: 'movie', tmdbId: 4 },
    {
      name: 'Persepolis',
      status: 'change',
      currentAudio: { streamId: 50, label: 'English', isExplicit: true },
      currentSubtitle: { streamId: null, label: 'None', isExplicit: false },
      proposedAudio: { streamId: 51, label: 'French (Original)', isExplicit: false },
    },
  );

  // Scoped by partId, not a raw array length: this repo's whole test suite shares
  // one scratch DB across every *.test.ts file, so a runApply call may legitimately
  // process other sibling tests' pending backlog (e.g. a still-retryable 'failed'
  // row from an earlier test in THIS file) in the same call.
  const putsByPartId = new Map<number, number>();
  await runApply(fakeCtx(), {
    appliedLogPrefix,
    now,
    putStreams: async (partId) => {
      putsByPartId.set(partId, (putsByPartId.get(partId) ?? 0) + 1);
    },
    triggerBackup: async () => ({ ok: true }),
  });
  assert.equal(putsByPartId.get(404), 1);

  // Simulate evaluate re-flagging the SAME file 'change' on a later run (e.g. a
  // fresh evaluate cycle re-ran and disagreed) — apply must still never re-touch it.
  markWorkItem('plex-language-evaluate', itemKey, 'success', {
    detail: {
      name: 'Persepolis',
      status: 'change',
      currentAudio: { streamId: 51, label: 'French (Original)', isExplicit: true },
      currentSubtitle: { streamId: null, label: 'None', isExplicit: false },
      proposedAudio: { streamId: 52, label: 'Yet Another Track', isExplicit: false },
    } satisfies EvaluateDetail,
  });

  await runApply(fakeCtx(), {
    appliedLogPrefix,
    now,
    putStreams: async (partId) => {
      putsByPartId.set(partId, (putsByPartId.get(partId) ?? 0) + 1);
    },
    triggerBackup: async () => ({ ok: true }),
  });

  assert.equal(putsByPartId.get(404), 1, 'a file already applied must never be re-applied automatically, even after evaluate re-flags it');
  console.log('  ✓ a file already applied is never re-touched, even after evaluate re-flags it "change"');
});

console.log('  ✓ plex-language-apply tests passed');
