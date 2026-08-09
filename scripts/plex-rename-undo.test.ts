// plex-rename-undo tests — in-memory fs seam + synthetic journals; no real disk, no Plex.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeMemFs } from '../src/workflows/plex-rename/memfs.js';
import type { JournalRecord } from '../src/workflows/plex-rename/journal.js';
import { runUndo } from './plex-rename-undo.js';

const AT = '2026-08-09T00:00:00.000Z';
const SILENT = () => {};

const FROM = '/Volumes/Share/Movies/Rel/old.mkv';
const TO = '/Volumes/Share/Movies/New/new.mkv';
const PARTIAL = `${TO}.plexrename-partial`;

function journalFor(opts: { ops?: unknown[]; doneRecords?: JournalRecord[]; terminal?: JournalRecord } = {}): JournalRecord[] {
  const ops = opts.ops ?? [
    { op: 'mkdir', path: '/Volumes/Share/Movies/New' },
    { op: 'move', from: FROM, to: TO, partial: PARTIAL, role: 'media', bytes: 11 },
  ];
  return [
    { kind: 'run-start', at: AT, applyEnabled: true, dailyCap: 30, pathMap: [{ plex: '/volume1/Share', local: '/Volumes/Share' }], mountsChecked: { '/volume1/share': true } } as JournalRecord,
    { kind: 'item-planned', at: AT, itemKey: 'K', ratingKey: 'r', partId: 1, title: 'A Movie', from: '/volume1/Share/Movies/Rel/old.mkv', to: '/volume1/Share/Movies/New/new.mkv', ops } as JournalRecord,
    ...(opts.doneRecords ?? [
      { kind: 'op-done', at: AT, itemKey: 'K', opIndex: 0 } as JournalRecord, // mkdir done
      { kind: 'op-done', at: AT, itemKey: 'K', opIndex: 1, step: 'copy' } as JournalRecord,
      { kind: 'op-done', at: AT, itemKey: 'K', opIndex: 1, step: 'verify' } as JournalRecord,
      { kind: 'op-done', at: AT, itemKey: 'K', opIndex: 1, step: 'finalize' } as JournalRecord,
      { kind: 'op-done', at: AT, itemKey: 'K', opIndex: 1, step: 'delete-source' } as JournalRecord,
    ]),
    ...(opts.terminal ? [opts.terminal] : [{ kind: 'item-done', at: AT, itemKey: 'K' } as JournalRecord]),
  ];
}

// The mount marker keeps /Volumes/Share a "healthy" implicit directory in the memfs.
const MOUNT_MARKER = { '/Volumes/Share/.mounted': 'x' };

test('undo: dry run (the default) mutates NOTHING and reports what it would do', async () => {
  const fs = makeMemFs({ ...MOUNT_MARKER, [TO]: 'MOVIE-BYTES' });
  const before = new Map(fs.files);
  const results = await runUndo(journalFor(), { apply: false, fs, log: SILENT });
  assert.deepEqual(fs.files, before, 'no mutation in dry-run');
  const move = results.find((r) => r.op === 'move');
  assert.equal(move?.outcome, 'dry-run');
});

test('undo: a completed move is reversed with the verified procedure (bytes travel back)', async () => {
  const fs = makeMemFs({ ...MOUNT_MARKER, [TO]: 'MOVIE-BYTES' });
  const results = await runUndo(journalFor(), { apply: true, fs, log: SILENT });
  const move = results.find((r) => r.op === 'move');
  assert.equal(move?.outcome, 'reverted');
  assert.equal(fs.files.get(FROM), 'MOVIE-BYTES', 'bytes are back at the original path');
  assert.equal(fs.files.has(TO), false);
  assert.ok(fs.oplog.some((o) => o.startsWith('copy:')), 'reversal used copy-verify-delete, not a bare rename');
});

test('undo: conflicts are never overwritten — occupied original, divergent duplicate, both-missing', async () => {
  // Original path re-occupied by something else.
  const occupied = makeMemFs({ ...MOUNT_MARKER, [TO]: 'MOVIE-BYTES', [FROM]: 'SOMETHING-ELSE!' });
  let results = await runUndo(journalFor(), { apply: true, fs: occupied, log: SILENT });
  assert.equal(results.find((r) => r.op === 'move')?.outcome, 'conflict');
  assert.equal(occupied.files.get(FROM), 'SOMETHING-ELSE!', 'occupant untouched');
  assert.equal(occupied.files.get(TO), 'MOVIE-BYTES', 'moved copy untouched');

  // Crash window artifact: both sides exist and are IDENTICAL → the copy is deleted.
  const dupEqual = makeMemFs({ ...MOUNT_MARKER, [TO]: 'MOVIE-BYTES', [FROM]: 'MOVIE-BYTES' });
  results = await runUndo(journalFor(), { apply: true, fs: dupEqual, log: SILENT });
  assert.equal(results.find((r) => r.op === 'move')?.outcome, 'reverted');
  assert.equal(dupEqual.files.has(TO), false, 'duplicate deleted');
  assert.equal(dupEqual.files.get(FROM), 'MOVIE-BYTES', 'original kept');

  // Neither side exists → loud conflict for manual review.
  const gone = makeMemFs({ ...MOUNT_MARKER });
  results = await runUndo(journalFor(), { apply: true, fs: gone, log: SILENT });
  assert.equal(results.find((r) => r.op === 'move')?.outcome, 'conflict');
});

test('undo: a stranded partial is deleted; an already-reverted move is recognized', async () => {
  const stranded = makeMemFs({ ...MOUNT_MARKER, [FROM]: 'MOVIE-BYTES', [PARTIAL]: 'HALF' });
  const results = await runUndo(
    journalFor({
      doneRecords: [
        { kind: 'op-done', at: AT, itemKey: 'K', opIndex: 0 } as JournalRecord,
        { kind: 'op-attempt', at: AT, itemKey: 'K', opIndex: 1, step: 'copy' } as JournalRecord,
      ],
      terminal: { kind: 'item-aborted', at: AT, itemKey: 'K', error: 'crash', completedOps: 1 } as JournalRecord,
    }),
    { apply: true, fs: stranded, log: SILENT },
  );
  assert.equal(stranded.files.has(PARTIAL), false, 'unverified partial deleted');
  assert.equal(stranded.files.get(FROM), 'MOVIE-BYTES', 'source untouched');
  const moveResults = results.filter((r) => r.op === 'move');
  assert.ok(moveResults.some((r) => r.outcome === 'reverted' && /partial/.test(r.detail ?? '')));
  assert.ok(moveResults.some((r) => r.outcome === 'already-reverted'), 'source-in-place recognized');
});

test('undo: .plexmatch restored only when untouched; mkdir removed only when empty', async () => {
  const pmPath = '/Volumes/Share/TV/Show {tvdb-1}/.plexmatch';
  const ops = [
    { op: 'mkdir', path: '/Volumes/Share/TV/Show {tvdb-1}' },
    { op: 'write-plexmatch', path: pmPath, content: 'title: Show\n', priorContent: null },
  ];
  const doneRecords = [
    { kind: 'op-done', at: AT, itemKey: 'K', opIndex: 0 } as JournalRecord,
    { kind: 'op-done', at: AT, itemKey: 'K', opIndex: 1 } as JournalRecord,
  ];

  // Untouched content → deleted (priorContent null); empty dir then removed.
  const clean = makeMemFs({ ...MOUNT_MARKER, [pmPath]: 'title: Show\n' });
  let results = await runUndo(journalFor({ ops, doneRecords }), { apply: true, fs: clean, log: SILENT });
  assert.equal(clean.files.has(pmPath), false, 'our .plexmatch deleted');
  assert.equal(results.find((r) => r.op === 'write-plexmatch')?.outcome, 'reverted');

  // Hand-edited since → conflict, file kept.
  const edited = makeMemFs({ ...MOUNT_MARKER, [pmPath]: 'title: Show\nep: 1: x.mkv\n' });
  results = await runUndo(journalFor({ ops, doneRecords }), { apply: true, fs: edited, log: SILENT });
  assert.equal(results.find((r) => r.op === 'write-plexmatch')?.outcome, 'conflict');
  assert.equal(edited.files.get(pmPath), 'title: Show\nep: 1: x.mkv\n', 'never clobbered');
});

test('undo: refuses outright when a journaled mount is absent', async () => {
  const fs = makeMemFs({ '/SomewhereElse/x': 'y' }); // /Volumes/Share does not exist at all
  const results = await runUndo(journalFor(), { apply: true, fs, log: SILENT });
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, 'failed');
  assert.match(results[0].detail ?? '', /mount missing/);
});
