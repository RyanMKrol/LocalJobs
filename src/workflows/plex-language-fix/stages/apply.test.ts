// apply.ts tests — against fakes only, never a real Plex server.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JobContext } from '../../../core/types.js';
import { getWorkItem } from '../../../db/store.js';
import type { AppliedLog, LanguageScanFile } from '../types.js';
import { JOB_NAME, runApply } from './apply.js';

function fakeCtx(): JobContext {
  return {
    log() {},
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

const dir = mkdtempSync(join(tmpdir(), 'plex-language-apply-'));
const scanPath = join(dir, 'language-scan.json');
const appliedLogPrefix = join(dir, 'applied-log');

function writeScan(items: LanguageScanFile['items']) {
  writeFileSync(scanPath, JSON.stringify({ generatedAt: new Date(0).toISOString(), sectionsScanned: [], items }));
}

function latestLog(): AppliedLog {
  const files = readdirSync(dir).filter((f) => f.startsWith('applied-log-')).sort();
  const last = files[files.length - 1];
  return JSON.parse(readFileSync(join(dir, last), 'utf8')) as AppliedLog;
}

let tick = 0;
const now = () => new Date(2026, 0, 1, 0, 0, tick++).toISOString();

// (a) a 'change' entry with a valid proposed audio streamId is applied and recorded 'success'.
{
  writeScan([
    {
      sectionTitle: 'Movies',
      ratingKey: '1',
      title: 'Amelie',
      type: 'movie',
      files: [
        {
          itemRatingKey: '1',
          itemTitle: 'Amelie',
          partId: 101,
          status: 'change',
          currentAudio: { streamId: 10, label: 'English', isExplicit: true },
          currentSubtitle: { streamId: null, label: 'None', isExplicit: false },
          proposedAudio: { streamId: 11, label: 'French (Original)', isExplicit: false },
          proposedSubtitle: { streamId: 20, label: 'English', isExplicit: false },
        },
      ],
    },
  ]);

  const puts: Array<{ partId: number; audio: number; subtitle: number | null }> = [];
  let backupCalled = false;
  await runApply(fakeCtx(), {
    scanPath,
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

  const row = getWorkItem(JOB_NAME, '101');
  assert.equal(row?.status, 'success');

  const log = latestLog();
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].outcome, 'applied');
  assert.equal(log.entries[0].beforeAudio?.streamId, 10);
  assert.equal(log.entries[0].afterAudio?.streamId, 11);
  assert.equal(log.entries[0].afterSubtitle?.streamId, 20);
  console.log('  ✓ a change entry is applied and recorded success, with before/after in the log');
}

// (b) an entry with a missing proposedAudio.streamId is skipped — not applied, not marked failed.
{
  writeScan([
    {
      sectionTitle: 'Movies',
      ratingKey: '2',
      title: 'Malformed Movie',
      type: 'movie',
      files: [
        {
          itemRatingKey: '2',
          itemTitle: 'Malformed Movie',
          partId: 202,
          status: 'change',
          currentAudio: { streamId: 30, label: 'English', isExplicit: true },
          currentSubtitle: { streamId: null, label: 'None', isExplicit: false },
          // proposedAudio deliberately absent
        },
      ],
    },
  ]);

  let putCalled = false;
  await runApply(fakeCtx(), {
    scanPath,
    appliedLogPrefix,
    now,
    putStreams: async () => {
      putCalled = true;
    },
    triggerBackup: async () => ({ ok: false, error: 'no changes to apply — backup not triggered' }),
  });

  assert.equal(putCalled, false, 'a malformed entry must never be PUT');
  const row = getWorkItem(JOB_NAME, '202');
  assert.equal(row, undefined, 'a skipped malformed entry must not be marked failed (or success)');
  console.log('  ✓ an entry with a missing proposedAudio.streamId is skipped, not applied or marked failed');
}

// (c) a PUT failure is recorded 'failed' with the error captured, and the run itself throws.
{
  writeScan([
    {
      sectionTitle: 'Movies',
      ratingKey: '3',
      title: 'Flaky Movie',
      type: 'movie',
      files: [
        {
          itemRatingKey: '3',
          itemTitle: 'Flaky Movie',
          partId: 303,
          status: 'change',
          currentAudio: { streamId: 40, label: 'English', isExplicit: true },
          currentSubtitle: { streamId: null, label: 'None', isExplicit: false },
          proposedAudio: { streamId: 41, label: 'Spanish (Original)', isExplicit: false },
        },
      ],
    },
  ]);

  await assert.rejects(
    () =>
      runApply(fakeCtx(), {
        scanPath,
        appliedLogPrefix,
        now,
        putStreams: async () => {
          throw new Error('Plex HTTP 500');
        },
        triggerBackup: async () => ({ ok: true }),
      }),
    /1\/1 file\(s\) failed to apply/,
  );

  const row = getWorkItem(JOB_NAME, '303');
  assert.equal(row?.status, 'failed');
  assert.ok(row?.detail?.includes('Plex HTTP 500'));

  const log = latestLog();
  assert.equal(log.entries[0].outcome, 'failed');
  assert.equal(log.entries[0].error, 'Plex HTTP 500');
  console.log('  ✓ a PUT failure is recorded failed with the error captured, and the run throws');
}

console.log('  ✓ plex-language-apply tests passed');
