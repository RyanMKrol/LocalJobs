import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCheckpoint } from './checkpoint.js';

test('marks are held until the save that covers them has happened', () => {
  const events: string[] = [];
  const cp = createCheckpoint(() => events.push('save'), { every: 3 });
  cp.defer(() => events.push('mark a'));
  cp.defer(() => events.push('mark b'));
  assert.equal(events.length, 0, 'nothing is marked before a save');
  assert.equal(cp.pending, 2);
  cp.defer(() => events.push('mark c')); // third mark triggers the checkpoint
  assert.deepEqual(events, ['save', 'mark a', 'mark b', 'mark c'], 'save first, then the marks, in order');
  assert.equal(cp.pending, 0);
});

test('a kill between checkpoints leaves the unsaved items unmarked (the safe direction)', () => {
  const marked: string[] = [];
  const cp = createCheckpoint(() => {}, { every: 10 });
  cp.defer(() => marked.push('a'));
  cp.defer(() => marked.push('b'));
  // The process dies here: flush() is never called.
  assert.deepEqual(marked, [], 'no item is recorded done without its data saved');
});

test('flush saves and applies whatever is still held; with nothing held it still saves', () => {
  const events: string[] = [];
  const cp = createCheckpoint(() => events.push('save'), { every: 10 });
  cp.defer(() => events.push('mark a'));
  cp.flush();
  assert.deepEqual(events, ['save', 'mark a']);
  cp.flush();
  assert.deepEqual(events, ['save', 'mark a', 'save']);
});

test('if the save throws, nothing is marked and the marks are kept for a later flush', () => {
  const marked: string[] = [];
  let failing = true;
  const cp = createCheckpoint(() => { if (failing) throw new Error('disk full'); });
  cp.defer(() => marked.push('a'));
  assert.throws(() => cp.flush(), /disk full/);
  assert.deepEqual(marked, []);
  assert.equal(cp.pending, 1);
  failing = false;
  cp.flush();
  assert.deepEqual(marked, ['a']);
});
