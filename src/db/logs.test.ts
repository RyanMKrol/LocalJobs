// Tests for the global cross-cutting log feed (T311). Runs against the scratch
// DB set by `npm test` (LOCALJOBS_DB). Self-asserting: throws on failure.
import assert from 'node:assert/strict';
import {
  createRun, createWorkflowRun, syncJob, syncWorkflow, listGlobalLogs,
} from './store.js';
import { db } from './index.js';

// member jobs must exist (runs.job_name FK → jobs.name)
syncJob({ name: 't311-job-a', run: async () => {} });
syncJob({ name: 't311-job-b', run: async () => {} });
syncWorkflow({ name: 't311-wf-a', jobs: [{ job: 't311-job-a' }] });
syncWorkflow({ name: 't311-wf-b', jobs: [{ job: 't311-job-b' }] });

const runA = createRun('t311-job-a', 'manual');
const runB = createRun('t311-job-b', 'manual');
const wfRunA = createWorkflowRun('t311-wf-a', 'manual');
const wfRunB = createWorkflowRun('t311-wf-b', 'manual');

function insertRunLog(runId: string, ts: string, level: string, message: string): void {
  db.prepare('INSERT INTO run_logs (run_id, ts, level, message) VALUES (?, ?, ?, ?)').run(runId, ts, level, message);
}
function insertWorkflowLog(workflowRunId: string, ts: string, level: string, message: string): void {
  db.prepare('INSERT INTO workflow_run_logs (workflow_run_id, ts, level, message) VALUES (?, ?, ?, ?)').run(workflowRunId, ts, level, message);
}

// ── (a) merged, newest-first, both sources present ──
{
  insertRunLog(runA, '2099-01-01 10:00:00', 'info', 'job a line 1');
  insertWorkflowLog(wfRunA, '2099-01-01 10:00:05', 'info', 'workflow a line 1');
  insertRunLog(runA, '2099-01-01 10:00:10', 'info', 'job a line 2');

  const { logs } = listGlobalLogs({ windowHours: 100000, limit: 10 });
  const jobLines = logs.filter((l) => l.source === 'job' && l.jobName === 't311-job-a');
  const wfLines = logs.filter((l) => l.source === 'workflow' && l.workflowName === 't311-wf-a');
  assert.ok(jobLines.length >= 2, 'job lines present');
  assert.ok(wfLines.length >= 1, 'workflow lines present');
  // newest-first
  const idx10 = logs.findIndex((l) => l.message === 'job a line 2');
  const idx05 = logs.findIndex((l) => l.message === 'workflow a line 1');
  const idx00 = logs.findIndex((l) => l.message === 'job a line 1');
  assert.ok(idx10 < idx05 && idx05 < idx00, 'sorted newest first by ts');
  const jl = logs.find((l) => l.message === 'job a line 1')!;
  assert.equal(jl.jobName, 't311-job-a');
  assert.equal(jl.workflowName, null);
  assert.equal(jl.runId, runA);
  assert.equal(jl.workflowRunId, null);
  const wl = logs.find((l) => l.message === 'workflow a line 1')!;
  assert.equal(wl.workflowName, 't311-wf-a');
  assert.equal(wl.jobName, null);
  assert.equal(wl.workflowRunId, wfRunA);
  assert.equal(wl.runId, null);
}
console.log('  ✓ listGlobalLogs merges job+workflow logs, newest first');

// ── (b) level filter ──
{
  insertRunLog(runB, '2099-01-02 09:00:00', 'warn', 'b warn line');
  insertRunLog(runB, '2099-01-02 09:00:01', 'error', 'b error line');
  insertRunLog(runB, '2099-01-02 09:00:02', 'info', 'b info line');

  const { logs: warnOnly } = listGlobalLogs({ levels: ['warn'], job: 't311-job-b', windowHours: 100000, limit: 50 });
  assert.ok(warnOnly.every((l) => l.level === 'warn'), 'single-level filter');
  assert.ok(warnOnly.some((l) => l.message === 'b warn line'));

  const { logs: warnError } = listGlobalLogs({ levels: ['warn', 'error'], job: 't311-job-b', windowHours: 100000, limit: 50 });
  assert.ok(warnError.every((l) => l.level === 'warn' || l.level === 'error'), 'multi-level filter');
  assert.equal(warnError.length, 2);
}
console.log('  ✓ listGlobalLogs level filter (single + comma-list)');

// ── (c) job / workflow scoping ──
{
  const { logs: jobScoped } = listGlobalLogs({ job: 't311-job-a', windowHours: 100000, limit: 50 });
  assert.ok(jobScoped.every((l) => l.source === 'job' && l.jobName === 't311-job-a'), 'job filter excludes workflow logs and other jobs');

  const { logs: wfScoped } = listGlobalLogs({ workflow: 't311-wf-a', windowHours: 100000, limit: 50 });
  assert.ok(wfScoped.every((l) => l.source === 'workflow' && l.workflowName === 't311-wf-a'), 'workflow filter excludes job logs and other workflows');
}
console.log('  ✓ listGlobalLogs job/workflow scoping');

// ── (e) free-text q, case-insensitive ──
{
  insertRunLog(runA, '2099-01-03 10:00:00', 'info', 'Special NEEDLE token here');
  const { logs } = listGlobalLogs({ q: 'needle', windowHours: 100000, limit: 50 });
  assert.ok(logs.some((l) => l.message === 'Special NEEDLE token here'), 'q matches case-insensitively');
  assert.ok(logs.every((l) => l.message.toLowerCase().includes('needle')));
}
console.log('  ✓ listGlobalLogs free-text q filter (case-insensitive)');

// ── (f)+(g) pagination across a same-second tie, no dupes/gaps, then null cursor ──
{
  const runC = createRun('t311-job-a', 'manual');
  const wfRunC = createWorkflowRun('t311-wf-a', 'manual');
  const tieTs = '2099-01-04 12:00:00';
  // 3 job rows + 2 workflow rows all sharing the exact same ts
  insertRunLog(runC, tieTs, 'info', 'tie job 1');
  insertRunLog(runC, tieTs, 'info', 'tie job 2');
  insertRunLog(runC, tieTs, 'info', 'tie job 3');
  insertWorkflowLog(wfRunC, tieTs, 'info', 'tie wf 1');
  insertWorkflowLog(wfRunC, tieTs, 'info', 'tie wf 2');

  const seen = new Set<string>();
  let before: string | undefined;
  let pages = 0;
  let sawNullCursor = false;
  for (let i = 0; i < 20; i++) {
    const { logs, nextCursor } = listGlobalLogs({ q: 'tie ', windowHours: 100000, limit: 2, before });
    for (const l of logs) {
      const key = `${l.source}:${l.id}`;
      assert.ok(!seen.has(key), `no duplicate row across pages: ${key}`);
      seen.add(key);
    }
    pages++;
    if (nextCursor == null) { sawNullCursor = true; break; }
    before = nextCursor;
  }
  assert.ok(sawNullCursor, 'pagination terminates with a null cursor');
  assert.ok(pages > 1, 'more than one page was needed');
  assert.equal(seen.size, 5, 'all 5 tied rows seen exactly once, no gaps');
}
console.log('  ✓ listGlobalLogs pagination is correct across a same-second tie (no dupes, no gaps, null cursor at end)');

// ── limit clamping is a route concern, but confirm store honours the given limit exactly ──
{
  const { logs } = listGlobalLogs({ windowHours: 100000, limit: 3 });
  assert.ok(logs.length <= 3, 'store respects the limit passed in');
}
console.log('  ✓ listGlobalLogs respects the given limit');
