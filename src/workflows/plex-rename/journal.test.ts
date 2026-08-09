// Journal tests — real files in a per-test temp dir (never a workflow's real data/).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyzeJournal, findLatestJournal, JournalWriter, readJournal, type JournalRecord } from './journal.js';

const AT = '2026-08-09T00:00:00.000Z';

function rec(partial: Partial<JournalRecord> & { kind: JournalRecord['kind'] }): JournalRecord {
  return { at: AT, ...partial } as JournalRecord;
}

test('JournalWriter appends fsynced NDJSON; readJournal round-trips and tolerates a torn tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plex-rename-journal-'));
  const w = new JournalWriter(dir, new Date('2026-08-09T05:00:00Z'));
  w.append(rec({ kind: 'run-start', applyEnabled: true, dailyCap: 30, pathMap: [], mountsChecked: {} } as never));
  w.append(rec({ kind: 'item-planned', itemKey: 'k', ratingKey: 'r', partId: 1, title: 'T', from: '/a', to: '/b', ops: [] } as never));
  w.close();

  assert.ok(w.path.includes('rename-journal-2026-08-09T05-00-00'), 'file named by timestamp');
  const roundTripped = readJournal(w.path);
  assert.equal(roundTripped.length, 2);
  assert.equal(roundTripped[0].kind, 'run-start');

  // Simulate a crash mid-append: a torn final line must not break parsing.
  writeFileSync(w.path, readFileSync(w.path, 'utf8') + '{"kind":"item-done","at":"2026', { flag: 'w' });
  const torn = readJournal(w.path);
  assert.equal(torn.length, 2, 'the torn tail is dropped, intact records preserved');

  assert.equal(findLatestJournal(dir), w.path);
  assert.equal(findLatestJournal(join(dir, 'nope')), null);
});

test('analyzeJournal classifies complete / aborted / unresolved and move-op completion', () => {
  const moveOp = { op: 'move', from: '/a/x.mkv', to: '/b/x.mkv', partial: '/b/x.mkv.plexrename-partial', role: 'media' } as const;
  const caseOnlyMove = { ...moveOp, caseOnly: true } as const;
  const records: JournalRecord[] = [
    rec({ kind: 'run-start', applyEnabled: true, dailyCap: 30, pathMap: [], mountsChecked: {} } as never),
    // item A: fully complete.
    rec({ kind: 'item-planned', itemKey: 'A', ratingKey: 'r1', partId: 1, title: 'A', from: '/a', to: '/b', ops: [moveOp] } as never),
    rec({ kind: 'op-attempt', itemKey: 'A', opIndex: 0, step: 'copy' } as never),
    rec({ kind: 'op-done', itemKey: 'A', opIndex: 0, step: 'copy' } as never),
    rec({ kind: 'op-done', itemKey: 'A', opIndex: 0, step: 'verify' } as never),
    rec({ kind: 'op-done', itemKey: 'A', opIndex: 0, step: 'finalize' } as never),
    rec({ kind: 'op-done', itemKey: 'A', opIndex: 0, step: 'delete-source' } as never),
    rec({ kind: 'item-done', itemKey: 'A' } as never),
    // item B: crashed after finalize (no delete-source, no terminal record).
    rec({ kind: 'item-planned', itemKey: 'B', ratingKey: 'r2', partId: 2, title: 'B', from: '/a', to: '/b', ops: [moveOp] } as never),
    rec({ kind: 'op-attempt', itemKey: 'B', opIndex: 0, step: 'copy' } as never),
    rec({ kind: 'op-done', itemKey: 'B', opIndex: 0, step: 'copy' } as never),
    rec({ kind: 'op-done', itemKey: 'B', opIndex: 0, step: 'verify' } as never),
    rec({ kind: 'op-done', itemKey: 'B', opIndex: 0, step: 'finalize' } as never),
    // item C: aborted cleanly.
    rec({ kind: 'item-planned', itemKey: 'C', ratingKey: 'r3', partId: 3, title: 'C', from: '/a', to: '/b', ops: [moveOp] } as never),
    rec({ kind: 'op-failed', itemKey: 'C', opIndex: 0, step: 'verify', error: 'checksum' } as never),
    rec({ kind: 'item-aborted', itemKey: 'C', error: 'checksum', completedOps: 0 } as never),
    // item D: case-only move — 'finalize' is its LAST step, so it IS done.
    rec({ kind: 'item-planned', itemKey: 'D', ratingKey: 'r4', partId: 4, title: 'D', from: '/a', to: '/b', ops: [caseOnlyMove] } as never),
    rec({ kind: 'op-done', itemKey: 'D', opIndex: 0, step: 'delete-source' } as never),
    rec({ kind: 'op-done', itemKey: 'D', opIndex: 0, step: 'finalize' } as never),
    rec({ kind: 'item-done', itemKey: 'D' } as never),
  ];

  const analysis = analyzeJournal(records);
  assert.equal(analysis.hasRunEnd, false, 'no run-end: the run crashed');
  const byKey = new Map(analysis.items.map((i) => [i.itemKey, i]));
  assert.equal(byKey.get('A')?.outcome, 'complete');
  assert.equal(byKey.get('A')?.ops[0].done, true, 'delete-source completed the standard move');
  assert.equal(byKey.get('B')?.outcome, 'unresolved');
  assert.equal(byKey.get('B')?.ops[0].done, false, 'finalize alone does not complete a standard move');
  assert.deepEqual(byKey.get('B')?.ops[0].doneSteps, ['copy', 'verify', 'finalize']);
  assert.equal(byKey.get('C')?.outcome, 'aborted');
  assert.equal(byKey.get('C')?.ops[0].failed, true);
  assert.equal(byKey.get('D')?.ops[0].done, true, 'finalize completes a case-only move (it runs last there)');
  assert.deepEqual(analysis.unresolved.map((i) => i.itemKey), ['B'], 'the crash-recovery worklist');
});
