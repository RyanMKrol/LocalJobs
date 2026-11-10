// markWorkItem's per-run snapshot (work_item_runs): the ledger row is overwritten
// in place by later runs, the snapshot is not, so a run's page can show what THAT
// run recorded. Also covers the `changed` flag, which separates "this run did
// something to the item" from "this run re-recorded it identically".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from './index.js';
import { createWorkflowRun, getWorkItem, markWorkItem, syncJob, syncWorkflow } from './store.js';

syncJob({ name: 'snap-job', run: async () => {} });
syncWorkflow({ name: 'snap-wf', jobs: [{ job: 'snap-job' }] });

interface Snap { run_id: string | null; status: string | null; attempts: number | null; detail: string | null; title: string | null; input_job: string | null; input_key: string | null; changed: number | null; at_ms: number | null }
const snap = (wf: string, key: string) =>
  db.prepare('SELECT run_id, status, attempts, detail, title, input_job, input_key, changed, at_ms FROM work_item_runs WHERE workflow_run_id = ? AND job_name = ? AND item_key = ?')
    .get(wf, 'snap-job', key) as Snap;

test('each run freezes what IT recorded; a later run overwriting the ledger does not rewrite history', () => {
  const run1 = createWorkflowRun('snap-wf', 'manual');
  const run2 = createWorkflowRun('snap-wf', 'manual');
  markWorkItem('snap-job', 'item', 'failed', { attempts: 1, detail: { name: 'Thing', error: 'boom' }, workflowRunId: run1, runId: 'attempt-1' });
  markWorkItem('snap-job', 'item', 'success', { attempts: 2, detail: { name: 'Thing', value: 42 }, workflowRunId: run2, runId: 'attempt-2' });

  assert.equal(getWorkItem('snap-job', 'item')?.status, 'success', 'the ledger holds only the latest state');
  const s1 = snap(run1, 'item');
  assert.equal(s1.status, 'failed');
  assert.equal(s1.attempts, 1);
  assert.deepEqual(JSON.parse(s1.detail!), { name: 'Thing', error: 'boom' }, "run 1's page still shows the failure it recorded");
  assert.equal(s1.run_id, 'attempt-1');
  assert.equal(s1.title, 'Thing', 'the title defaults to detail.name');
  assert.equal(typeof s1.at_ms, 'number');
  const s2 = snap(run2, 'item');
  assert.equal(s2.status, 'success');
  assert.deepEqual(JSON.parse(s2.detail!), { name: 'Thing', value: 42 });
});

test('changed = 1 for a new item or a different status/attempts/detail; 0 for an identical re-record, whose detail is not stored again', () => {
  const run1 = createWorkflowRun('snap-wf', 'manual');
  const run2 = createWorkflowRun('snap-wf', 'manual');
  const run3 = createWorkflowRun('snap-wf', 'manual');
  const detail = { name: 'Catalogue entry', size: 1000 };
  markWorkItem('snap-job', 'cat', 'success', { detail, workflowRunId: run1 });
  assert.equal(snap(run1, 'cat').changed, 1, 'brand new');

  markWorkItem('snap-job', 'cat', 'success', { detail, workflowRunId: run2 });
  const again = snap(run2, 'cat');
  assert.equal(again.changed, 0, 'an identical re-record changed nothing');
  assert.equal(again.detail, null, 'so its detail is not duplicated (a re-recorded catalogue costs almost nothing)');
  assert.equal(again.status, 'success');

  markWorkItem('snap-job', 'cat', 'success', { detail: { ...detail, size: 2000 }, workflowRunId: run3 });
  assert.equal(snap(run3, 'cat').changed, 1, 'a different detail is a change');
});

test('within one run, a later identical re-mark does not erase an earlier real change', () => {
  const run = createWorkflowRun('snap-wf', 'manual');
  markWorkItem('snap-job', 'twice', 'success', { detail: { name: 'X', v: 1 }, workflowRunId: run });
  markWorkItem('snap-job', 'twice', 'success', { detail: { name: 'X', v: 1 }, workflowRunId: run });
  const s = snap(run, 'twice');
  assert.equal(s.changed, 1);
  assert.deepEqual(JSON.parse(s.detail!), { name: 'X', v: 1 }, 'the frozen detail survives the identical re-mark');
});

test('`from` records the upstream item this one was made from (falling back to parentJob/parentKey)', () => {
  const run = createWorkflowRun('snap-wf', 'manual');
  markWorkItem('snap-job', 'a', 'success', { from: { job: 'upstream-job' }, workflowRunId: run });
  assert.deepEqual([snap(run, 'a').input_job, snap(run, 'a').input_key], ['upstream-job', 'a'], 'the key defaults to the same key');
  markWorkItem('snap-job', 'b', 'success', { from: { job: 'upstream-job', key: 'other' }, workflowRunId: run });
  assert.deepEqual([snap(run, 'b').input_job, snap(run, 'b').input_key], ['upstream-job', 'other']);
  markWorkItem('snap-job', 'c', 'success', { parentJob: 'resolver', parentKey: 'cid-1', rootKey: 'cid-1', workflowRunId: run });
  assert.deepEqual([snap(run, 'c').input_job, snap(run, 'c').input_key], ['resolver', 'cid-1']);
  markWorkItem('snap-job', 'd', 'success', { workflowRunId: run });
  assert.deepEqual([snap(run, 'd').input_job, snap(run, 'd').input_key], [null, null]);
});

test('an oversized detail keeps only its display keys in the snapshot; the ledger keeps all of it', () => {
  const run = createWorkflowRun('snap-wf', 'manual');
  const big = { name: 'Huge', path: '/tmp/x.json', format: 'json', blob: 'x'.repeat(40_000) };
  markWorkItem('snap-job', 'big', 'success', { detail: big, workflowRunId: run });
  assert.deepEqual(JSON.parse(snap(run, 'big').detail!), { _truncated: true, name: 'Huge', path: '/tmp/x.json', format: 'json' });
  assert.equal(JSON.parse(getWorkItem('snap-job', 'big')!.detail!).blob.length, 40_000);
});

test('a standalone mark (no workflow run) writes the ledger only', () => {
  markWorkItem('snap-job', 'solo', 'success', { workflowRunId: null });
  assert.equal(getWorkItem('snap-job', 'solo')?.status, 'success');
  assert.equal((db.prepare("SELECT COUNT(*) c FROM work_item_runs WHERE item_key = 'solo'").get() as { c: number }).c, 0);
});
