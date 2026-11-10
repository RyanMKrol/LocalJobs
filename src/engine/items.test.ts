// eachItem: the item loop, once. Each test is one of the rules a hand-written
// loop used to have to remember (and that some stage, somewhere, got wrong).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../db/index.js';
import { createWorkflowRun, getWorkItem, markWorkItem, syncJob, syncWorkflow } from '../db/store.js';
import { FatalStageError, ItemFailure, SoftStopError, eachItem, snapshotLedger, softStop } from './items.js';
import type { JobContext, LogLevel } from './types.js';

function ctx(roots: string[] | null = null) {
  const logs: { level: LogLevel; message: string }[] = [];
  const progress: number[] = [];
  const set = roots ? new Set(roots) : null;
  const c: JobContext = {
    log: (message, level = 'info') => { logs.push({ level, message }); },
    progress: (pct) => { progress.push(Math.round(pct)); },
    selectedRoots: () => set,
    rootAllowed: (k) => !set || set.has(k),
  };
  return { c, logs, progress, text: () => logs.map((l) => l.message).join('\n') };
}
let n = 0;
const job = () => `items-job-${++n}`;
const base = { key: (s: string) => s, maxAttempts: 3 };
const status = (j: string, k: string) => getWorkItem(j, k)?.status;

test('processes every item, records what the handler returns, and reports progress per item', async () => {
  const j = job();
  const { c, progress, text } = ctx();
  const tally = await eachItem(c, j, ['a', 'b', 'c'], { ...base, title: (s) => `Item ${s}` }, async (s) => ({ value: s.toUpperCase() }));
  assert.deepEqual({ ok: tally.ok, failed: tally.failed, attempted: tally.attempted }, { ok: 3, failed: 0, attempted: 3 });
  assert.deepEqual(JSON.parse(getWorkItem(j, 'b')!.detail!), { name: 'Item b', value: 'B' }, 'detail = title + what the handler returned');
  assert.deepEqual(progress, [33, 67, 100], 'progress advances per item, not 0 → 100 at the end');
  assert.match(text(), /\[2\/3\] ✓ "Item b"/);
});

test('items the ledger already has done are skipped; a re-run does nothing', async () => {
  const j = job();
  let calls = 0;
  await eachItem(ctx().c, j, ['a', 'b'], base, async () => { calls++; });
  const again = await eachItem(ctx().c, j, ['a', 'b', 'c'], base, async () => { calls++; });
  assert.equal(calls, 3, 'only the new item was processed the second time');
  assert.equal(again.alreadyDone, 2);
});

test('a failing item is recorded failed with a COUNTED attempt, the loop carries on, and the run fails at the end', async () => {
  const j = job();
  const seen: string[] = [];
  await assert.rejects(
    () => eachItem(ctx().c, j, ['a', 'bad', 'c'], base, async (s) => { seen.push(s); if (s === 'bad') throw new Error('nope'); }),
    /1\/3 item\(s\) failed this run/,
  );
  assert.deepEqual(seen, ['a', 'bad', 'c'], 'one bad item does not stop the others');
  assert.equal(status(j, 'a'), 'success');
  assert.equal(status(j, 'c'), 'success');
  const bad = getWorkItem(j, 'bad')!;
  assert.equal(bad.status, 'failed');
  assert.equal(bad.attempts, 1);
  assert.equal(JSON.parse(bad.detail!).error, 'nope');
});

test('an ItemFailure keeps its diagnostics on the failed row alongside the message', async () => {
  const j = job();
  await assert.rejects(() => eachItem(ctx().c, j, ['blocked'], base, async () => {
    throw new ItemFailure('page too short', { httpStatus: 403, pageTitle: 'Just a moment...' });
  }));
  const detail = JSON.parse(getWorkItem(j, 'blocked')!.detail!);
  assert.deepEqual(detail, { name: 'blocked', httpStatus: 403, pageTitle: 'Just a moment...', error: 'page too short' });
});

test('attempts accumulate across runs: after maxAttempts the item is given up on and the stage passes again', async () => {
  const j = job();
  const run = () => eachItem(ctx().c, j, ['bad'], base, async () => { throw new Error('always'); });
  await assert.rejects(run);
  await assert.rejects(run);
  await assert.rejects(run);
  assert.equal(getWorkItem(j, 'bad')!.attempts, 3);
  const after = await run(); // done-by-exhaustion: not attempted, so nothing fails
  assert.equal(after.attempted, 0);
  assert.equal(after.alreadyDone, 1);
});

test('a soft stop (returned, or a thrown SoftStopError) ends the loop gracefully: item skipped, no attempt counted, run succeeds', async () => {
  for (const how of ['return', 'throw'] as const) {
    const j = job();
    const seen: string[] = [];
    const tally = await eachItem(ctx().c, j, ['a', 'limit', 'c'], base, async (s) => {
      seen.push(s);
      if (s === 'limit') {
        if (how === 'throw') throw new SoftStopError('daily quota reached');
        return softStop('daily quota reached');
      }
    });
    assert.deepEqual(seen, ['a', 'limit'], `${how}: nothing after the stop is attempted`);
    assert.equal(tally.stopped, 'daily quota reached');
    assert.equal(tally.failed, 0);
    const row = getWorkItem(j, 'limit')!;
    assert.equal(row.status, 'skipped');
    assert.equal(row.attempts, 0, 'a soft stop is not an attempt');
    assert.equal(status(j, 'c'), undefined);
    // Next run resumes at the stopped item.
    const resumed = await eachItem(ctx().c, j, ['a', 'limit', 'c'], base, async () => {});
    assert.equal(resumed.attempted, 2);
    assert.equal(getWorkItem(j, 'limit')!.attempts, 1);
  }
});

test('a FatalStageError fails the run at once and leaves the item untouched for after the cause is fixed', async () => {
  const j = job();
  const seen: string[] = [];
  await assert.rejects(
    () => eachItem(ctx().c, j, ['a', 'dead', 'c'], base, async (s) => { seen.push(s); if (s === 'dead') throw new FatalStageError('credits depleted'); }),
    /credits depleted/,
  );
  assert.deepEqual(seen, ['a', 'dead']);
  assert.equal(status(j, 'a'), 'success', 'work done before the fatal error is kept');
  assert.equal(status(j, 'dead'), undefined, 'the item is not marked: it was never really attempted');
});

test('limit caps how many are attempted; the rest are reported as remaining', async () => {
  const j = job();
  const tally = await eachItem(ctx().c, j, ['a', 'b', 'c', 'd'], { ...base, limit: 2 }, async () => {});
  assert.equal(tally.attempted, 2);
  assert.equal(tally.remaining, 2);
  assert.equal(tally.stopped, 'per-run limit of 2 reached');
});

test('a limited run only touches items whose root is selected', async () => {
  const j = job();
  const seen: string[] = [];
  const tally = await eachItem(ctx(['root-1']).c, j, ['a', 'b', 'c'], { ...base, root: (s) => (s === 'b' ? 'root-1' : 'root-2') }, async (s) => { seen.push(s); });
  assert.deepEqual(seen, ['b']);
  assert.equal(tally.outsideLimit, 2);
  assert.equal(getWorkItem(j, 'b')!.root_key, 'root-1');
});

test('stopAfterConsecutiveFailures gives up on a run where everything is failing', async () => {
  const j = job();
  const seen: string[] = [];
  await assert.rejects(() => eachItem(ctx().c, j, ['a', 'b', 'c', 'd', 'e'], { ...base, stopAfterConsecutiveFailures: 2 }, async (s) => { seen.push(s); throw new Error('down'); }));
  assert.deepEqual(seen, ['a', 'b']);
});

test('with a shared file to save, an item is marked done only AFTER a save that covers it', async () => {
  const j = job();
  const events: string[] = [];
  const saved: string[] = [];
  const pending: string[] = [];
  await eachItem(ctx().c, j, ['a', 'b', 'c'], {
    ...base,
    saveEvery: 2,
    save: () => { saved.push(...pending.splice(0)); events.push(`save(${saved.length})`); },
  }, async (s) => {
    pending.push(s);
    events.push(`work ${s}: a is ${status(j, 'a') ?? 'unmarked'}`);
  });
  assert.deepEqual(events, [
    'work a: a is unmarked',
    'work b: a is unmarked', // a is NOT marked yet: its data has not been saved
    'save(2)',
    'work c: a is success',
    'save(3)',
  ]);
  assert.equal(status(j, 'c'), 'success');
});

test('a throw mid-loop still saves and marks what was completed before it', async () => {
  const j = job();
  let saves = 0;
  await assert.rejects(() => eachItem(ctx().c, j, ['a', 'dead'], { ...base, save: () => { saves++; }, saveEvery: 10 }, async (s) => {
    if (s === 'dead') throw new FatalStageError('stop');
  }));
  assert.equal(saves, 1);
  assert.equal(status(j, 'a'), 'success');
});

test('`from` and `ledger`: rows go to a named ledger and record the upstream item they were made from', async () => {
  const j = job();
  syncJob({ name: j, run: async () => {} });
  syncWorkflow({ name: `${j}-wf`, jobs: [{ job: j }] });
  const wf = createWorkflowRun(`${j}-wf`, 'manual');
  process.env.LOCALJOBS_WORKFLOW_RUN_ID = wf;
  process.env.LOCALJOBS_RUN_ID = 'attempt-x';
  try {
    await eachItem(ctx().c, j, [{ id: 'p1', src: 'cid-1' }], {
      key: (p) => p.id, maxAttempts: 3, ledger: 'shared-ledger', from: { job: 'upstream', key: (p) => p.src }, root: (p) => p.src,
    }, async () => ({ done: true }));
  } finally {
    delete process.env.LOCALJOBS_WORKFLOW_RUN_ID;
    delete process.env.LOCALJOBS_RUN_ID;
  }
  assert.equal(getWorkItem('shared-ledger', 'p1')?.status, 'success');
  const snap = db.prepare("SELECT run_id, input_job, input_key, root_key, changed FROM work_item_runs WHERE workflow_run_id = ? AND item_key = 'p1'").get(wf);
  assert.deepEqual(snap, { run_id: 'attempt-x', input_job: 'upstream', input_key: 'cid-1', root_key: 'cid-1', changed: 1 });
});

test('snapshotLedger: reports new / changed / unchanged, and prunes rows no longer present (unlimited runs only)', () => {
  const j = job();
  const first = snapshotLedger(ctx().c, j, [{ key: 'a', detail: { v: 1 } }, { key: 'b', detail: { v: 1 } }, { key: 'gone', detail: {} }]);
  assert.deepEqual({ added: first.added, changed: first.changed, unchanged: first.unchanged }, { added: 3, changed: 0, unchanged: 0 });

  const second = snapshotLedger(ctx().c, j, [{ key: 'a', detail: { v: 1 } }, { key: 'b', detail: { v: 2 } }, { key: 'c', detail: {} }], { prune: true });
  assert.deepEqual(second, { added: 1, changed: 1, unchanged: 1, removed: 1, outsideLimit: 0 });
  assert.equal(getWorkItem(j, 'gone'), undefined);

  // A limited run re-records only its roots and never prunes.
  markWorkItem(j, 'keep-me', 'success', {});
  const limited = snapshotLedger(ctx(['a']).c, j, [{ key: 'a', detail: { v: 9 } }, { key: 'b', detail: { v: 9 } }], { prune: true });
  assert.deepEqual({ changed: limited.changed, removed: limited.removed, outsideLimit: limited.outsideLimit }, { changed: 1, removed: 0, outsideLimit: 1 });
  assert.ok(getWorkItem(j, 'keep-me'), 'nothing pruned on a limited run');
  assert.deepEqual(JSON.parse(getWorkItem(j, 'b')!.detail!), { v: 2 }, 'an item outside the limit was not re-recorded');
});
