// pruneRunHistoryChunk: old runs lose their per-run I/O detail in chunks; recent
// runs, each workflow's newest N runs, running runs, and everything that is not
// I/O detail (the runs themselves, logs, the ledger) are all kept.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from './index.js';
import {
  createWorkflowRun, finishWorkflowRun, getWorkItem, getWorkflowRun, markWorkItem, pruneRunHistoryChunk,
  recordRunInput, syncJob, syncWorkflow,
} from './store.js';

syncJob({ name: 'ret-job', run: async () => {} });
syncWorkflow({ name: 'ret-wf', jobs: [{ job: 'ret-job' }] });

function run(daysAgo: number, items: number, opts: { running?: boolean } = {}): string {
  const id = createWorkflowRun('ret-wf', 'schedule');
  db.prepare("UPDATE workflow_runs SET started_at = datetime('now', ?) WHERE id = ?").run(`-${daysAgo} days`, id);
  for (let i = 0; i < items; i++) markWorkItem('ret-job', `${id}-item-${i}`, 'success', { workflowRunId: id });
  recordRunInput({ workflowRunId: id, cycle: 1, jobName: 'ret-job', port: 'p', producerJob: 'x', artifactKey: 'p', ok: true });
  if (!opts.running) finishWorkflowRun(id, 'success');
  return id;
}
const linkage = (id: string) => (db.prepare('SELECT COUNT(*) c FROM work_item_runs WHERE workflow_run_id = ?').get(id) as { c: number }).c;
const inputs = (id: string) => (db.prepare('SELECT COUNT(*) c FROM run_inputs WHERE workflow_run_id = ?').get(id) as { c: number }).c;

test('old runs are trimmed chunk by chunk; recent, newest-N and running runs are kept', () => {
  const ancient = run(400, 7);       // old, not in the newest 2 → trimmed
  const old = run(200, 3);           // old, not in the newest 2 → trimmed
  const oldRunning = run(150, 2, { running: true }); // old but RUNNING → kept
  const keptByCount = run(120, 4);   // old, but among the newest 2 → kept
  const recent = run(1, 5);          // recent → kept

  const opts = { keepDays: 90, keepRunsPerWorkflow: 2, chunk: 4 };
  // Oldest first, never more than `chunk` rows per call.
  assert.deepEqual(pruneRunHistoryChunk(opts), { deleted: 4, done: false });
  assert.equal(linkage(ancient), 3);
  assert.equal(inputs(ancient), 1, 'small per-run records go once the big table is drained for that run');
  assert.deepEqual(pruneRunHistoryChunk(opts), { deleted: 4, done: false }); // 3 linkage + 1 run_inputs
  assert.equal(linkage(ancient), 0);
  assert.equal(inputs(ancient), 0);
  assert.deepEqual(pruneRunHistoryChunk(opts), { deleted: 4, done: false }); // `old`: 3 linkage + 1 run_inputs
  assert.deepEqual(pruneRunHistoryChunk(opts), { deleted: 0, done: true });

  assert.equal(linkage(old), 0);
  assert.equal(linkage(oldRunning), 2, 'a running run is never trimmed');
  assert.equal(linkage(keptByCount), 4, "a workflow's newest N runs are kept however old");
  assert.equal(linkage(recent), 5);
  assert.equal(inputs(recent), 1);

  // Only I/O detail went: the run row and the ledger are intact.
  assert.equal(getWorkflowRun(ancient)?.status, 'success');
  assert.equal(getWorkItem('ret-job', `${ancient}-item-0`)?.status, 'success');
  finishWorkflowRun(oldRunning, 'cancelled');
});
