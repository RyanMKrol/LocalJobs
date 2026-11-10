// deleteLedgerOfJob removes one job's ledger and its per-run records, and nothing else.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRun, createWorkflowRun, deleteLedgerOfJob, getWorkItem, ledgerSize, markWorkItem, syncJob, syncWorkflow } from './store.js';

test('deleting a display-only ledger leaves every other ledger alone, and is a no-op the second time', () => {
  const run = async () => {};
  syncJob({ name: 'dl-display', run });
  syncJob({ name: 'dl-real', run });
  syncWorkflow({ name: 'dl-wf', jobs: [{ job: 'dl-display' }, { job: 'dl-real' }] });
  const wfRun = createWorkflowRun('dl-wf', 'manual');
  const runId = createRun('dl-display', 'workflow', 1, wfRun);
  markWorkItem('dl-display', '2026-W01', 'success', { detail: { name: 'week 1' }, workflowRunId: wfRun, runId });
  markWorkItem('dl-display', '2026-W02', 'success', { detail: { name: 'week 2' }, workflowRunId: wfRun, runId });
  markWorkItem('dl-real', 'item-1', 'success', { detail: { name: 'kept' }, workflowRunId: wfRun, runId });

  assert.deepEqual(ledgerSize('dl-display'), { workItems: 2, workItemRuns: 2 });
  assert.deepEqual(deleteLedgerOfJob('dl-display'), { workItems: 2, workItemRuns: 2 });
  assert.deepEqual(ledgerSize('dl-display'), { workItems: 0, workItemRuns: 0 });
  assert.equal(getWorkItem('dl-real', 'item-1')?.status, 'success', 'another job\'s ledger is untouched');
  assert.deepEqual(ledgerSize('dl-real'), { workItems: 1, workItemRuns: 1 });
  assert.deepEqual(deleteLedgerOfJob('dl-display'), { workItems: 0, workItemRuns: 0 }, 'safe to re-run');
});
