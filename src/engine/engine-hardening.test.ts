// Engine-hardening scenarios: the workflow engine behaviours that used to be
// untested (and, in several cases, wrong or unrecorded). Each test names the
// guarantee it protects.
//
//   - fan-in / diamond with a failing branch: the join waits for every branch and
//     is skipped, with a recorded reason naming what failed
//   - cancel during a parallel wave: every in-flight stage is killed AND every
//     stage that never started still gets a row saying so
//   - gates: a hanging or rejecting check fails the gate instead of hanging the
//     run; every inbound gate is evaluated and recorded at run time
//   - retries inside a workflow: one row per attempt, run identity reaches the child
//   - repeatUntilStable: noop/stalled tracking is per cycle; the pause is cancellable
//   - daemon restart: a reaped run records why, how long, and what never started
//   - child output that is JSON but not an event is logged, not dropped
//
// Member execution uses a FAKE child script (config.runJobScript), so no real job
// runs. Runs against the scratch DB.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { jobs, notifications } from './testing/fixture-host.js';
import {
  createRun, createWorkflowRun, getLogs, getRun, getWorkflowLogs, getWorkflowRun, lastWorkflowRunForWorkflow,
  listRunsForJob, listRunsForWorkflowRun, markWorkItem, reapOrphanRuns, reapOrphanWorkflowRuns,
  runInputsForStage, runInputsForWorkflowRun, syncJob, syncWorkflow,
} from '../db/store.js';
import { cancelWorkflowRun, isWorkflowRunActive, runWorkflow } from './workflow-executor.js';
import { retryDelayMs, runJobForWorkflow } from './executor.js';
import { ENGINE_PROTOCOL } from './protocol.js';
import type { JobDefinition, RunRow, WorkflowDefinition } from './types.js';

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    process.exitCode = 1;
  }
}

// Fake child. Behaviour is chosen by the job-name prefix:
//   hang*      never finishes (must be killed)
//   fail*      reports a failed result
//   flaky*     fails on attempt 1, succeeds on attempt 2+ (reads LOCALJOBS_RUN_ATTEMPT)
//   cyclefail* succeeds in cycle 1, fails in cycle 2+ (reads LOCALJOBS_RUN_CYCLE)
//   chatty*    prints JSON that is not an event, then succeeds
//   env*       logs the run identity env it was given, then succeeds
//   anything else succeeds immediately
const FAKE = `
const name = process.argv[2] ?? '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const done = (o, code) => process.stdout.write(JSON.stringify(o) + '\\n', () => process.exit(code));
const ok = () => done({ type: 'result', status: 'success' }, 0);
const fail = (why) => done({ type: 'result', status: 'failed', error: why }, 1);
if (name.startsWith('hang')) setTimeout(() => {}, 60000);
else if (name.startsWith('fail')) fail('planned failure');
else if (name.startsWith('flaky')) (Number(process.env.LOCALJOBS_RUN_ATTEMPT) >= 2 ? ok() : fail('first attempt always fails'));
else if (name.startsWith('cyclefail')) (Number(process.env.LOCALJOBS_RUN_CYCLE) >= 2 ? fail('fails from cycle 2') : ok());
else if (name.startsWith('chatty')) {
  process.stdout.write('42\\n');
  process.stdout.write(JSON.stringify({ type: 'mystery', payload: 'from-the-future' }) + '\\n');
  process.stdout.write('null\\n');
  ok();
}
else if (name.startsWith('env')) {
  out({ type: 'log', level: 'info', message: 'ENV ' + JSON.stringify({
    engine: process.env.LOCALJOBS_ENGINE, runId: process.env.LOCALJOBS_RUN_ID, attempt: process.env.LOCALJOBS_RUN_ATTEMPT,
    cycle: process.env.LOCALJOBS_RUN_CYCLE, wf: process.env.LOCALJOBS_WORKFLOW_NAME, wfRun: process.env.LOCALJOBS_WORKFLOW_RUN_ID,
    trigger: process.env.LOCALJOBS_RUN_TRIGGER }) });
  ok();
}
else ok();
`;

const dir = mkdtempSync(join(tmpdir(), 'lj-engine-'));
const fakePath = join(dir, 'fake-runner.mjs');
writeFileSync(fakePath, FAKE);

const orig = { script: config.runJobScript, topic: config.ntfyTopic, gateTimeout: config.gateTimeoutMs, backoff: config.retryBackoffMs };
config.runJobScript = fakePath;
config.ntfyTopic = '';

const pushed: JobDefinition[] = [];
function job(d: JobDefinition): JobDefinition {
  syncJob(d);
  jobs.push(d);
  pushed.push(d);
  return d;
}
const plain = (...names: string[]) => names.forEach((name) => job({ name, run: async () => {} }));

const byJob = (runs: RunRow[], name: string) => runs.filter((r) => r.job_name === name);
const logText = (wfRun: string) => getWorkflowLogs(wfRun).map((l) => l.message).join('\n');

async function waitActive(workflow: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const r = lastWorkflowRunForWorkflow(workflow);
    if (r && r.status === 'running' && isWorkflowRunActive(r.id)) return r.id;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`workflow ${workflow} never became active`);
}

async function waitFor(what: string, pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

try {
  await test('fan-in: one failed branch skips the join; the other branches still ran; the reason names the failed branch', async () => {
    plain('fi-src', 'fi-b1', 'fail-fi-b2', 'fi-b3', 'fi-join', 'fi-after');
    const def: WorkflowDefinition = {
      name: 'eh-fan-in',
      jobs: [
        { job: 'fi-src' },
        { job: 'fi-b1', dependsOn: ['fi-src'] },
        { job: 'fail-fi-b2', dependsOn: ['fi-src'] },
        { job: 'fi-b3', dependsOn: ['fi-src'] },
        { job: 'fi-join', dependsOn: ['fi-b1', 'fail-fi-b2', 'fi-b3'] },
        { job: 'fi-after', dependsOn: ['fi-join'] },
      ],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    const runs = listRunsForWorkflowRun(workflowRunId!);
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'partial');
    for (const ok of ['fi-src', 'fi-b1', 'fi-b3']) assert.equal(byJob(runs, ok)[0]?.status, 'success', `${ok} ran`);
    assert.equal(byJob(runs, 'fail-fi-b2')[0]?.status, 'failed');
    const join = byJob(runs, 'fi-join')[0];
    assert.equal(join?.status, 'skipped', 'the fan-in did not run: not every branch succeeded');
    assert.equal(join?.outcome_reason, 'upstream-skipped');
    assert.match(join?.error ?? '', /fail-fi-b2 did not succeed \(failed\)/);
    const after = byJob(runs, 'fi-after')[0];
    assert.equal(after?.status, 'skipped', 'the skip cascades');
    assert.match(after?.error ?? '', /fi-join did not succeed \(skipped\)/);
  });

  await test('fan-in: when SEVERAL branches fail, the skip reason names every one of them', async () => {
    plain('fm-src', 'fail-fm-b1', 'fail-fm-b2', 'fm-b3', 'fm-join');
    const def: WorkflowDefinition = {
      name: 'eh-fan-in-multi',
      jobs: [
        { job: 'fm-src' },
        { job: 'fail-fm-b1', dependsOn: ['fm-src'] },
        { job: 'fail-fm-b2', dependsOn: ['fm-src'] },
        { job: 'fm-b3', dependsOn: ['fm-src'] },
        { job: 'fm-join', dependsOn: ['fail-fm-b1', 'fail-fm-b2', 'fm-b3'] },
      ],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    const join = byJob(listRunsForWorkflowRun(workflowRunId!), 'fm-join')[0];
    assert.match(join?.error ?? '', /2 upstream stages did not succeed/);
    assert.match(join?.error ?? '', /fail-fm-b1 \(failed\)/);
    assert.match(join?.error ?? '', /fail-fm-b2 \(failed\)/);
  });

  await test('diamond: one failing side skips the join while the other side succeeds', async () => {
    plain('dm-top', 'dm-left', 'fail-dm-right', 'dm-bottom');
    const def: WorkflowDefinition = {
      name: 'eh-diamond',
      jobs: [
        { job: 'dm-top' },
        { job: 'dm-left', dependsOn: ['dm-top'] },
        { job: 'fail-dm-right', dependsOn: ['dm-top'] },
        { job: 'dm-bottom', dependsOn: ['dm-left', 'fail-dm-right'] },
      ],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    const runs = listRunsForWorkflowRun(workflowRunId!);
    assert.equal(byJob(runs, 'dm-left')[0]?.status, 'success');
    assert.equal(byJob(runs, 'fail-dm-right')[0]?.status, 'failed');
    assert.equal(byJob(runs, 'dm-bottom')[0]?.status, 'skipped');
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'partial');
  });

  await test('cancel during a parallel wave: every in-flight stage is killed, and stages that never started get a row saying so', async () => {
    plain('hang-pw-1', 'hang-pw-2', 'hang-pw-3', 'pw-join', 'pw-after');
    const def: WorkflowDefinition = {
      name: 'eh-cancel-wave',
      maxConcurrency: 2, // 2 run, the 3rd waits for a slot: "ready but queued" must be recorded too
      jobs: [
        { job: 'hang-pw-1' }, { job: 'hang-pw-2' }, { job: 'hang-pw-3' },
        { job: 'pw-join', dependsOn: ['hang-pw-1', 'hang-pw-2', 'hang-pw-3'] },
        { job: 'pw-after', dependsOn: ['pw-join'] },
      ],
    };
    syncWorkflow(def);
    const p = runWorkflow(def, 'manual');
    const wrid = await waitActive('eh-cancel-wave');
    await waitFor('two stages in flight', () => listRunsForWorkflowRun(wrid).filter((r) => r.status === 'running').length === 2);
    assert.equal(cancelWorkflowRun(wrid, 'cancelled by the test'), true);
    await p;

    const run = getWorkflowRun(wrid)!;
    assert.equal(run.status, 'cancelled');
    assert.equal(run.end_reason, 'cancelled by the test', 'the cancel reason is recorded on the run');
    const runs = listRunsForWorkflowRun(wrid);
    const killed = runs.filter((r) => r.status === 'cancelled' && r.outcome_reason == null);
    assert.equal(killed.length, 2, 'both in-flight stages were killed');
    const notStarted = runs.filter((r) => r.outcome_reason === 'not-started-cancelled');
    assert.deepEqual(
      notStarted.map((r) => r.job_name).sort(),
      ['hang-pw-3', 'pw-after', 'pw-join'],
      'the queued stage and both downstream stages are recorded as not started',
    );
    assert.ok(notStarted.every((r) => r.status === 'cancelled'));
    assert.match(logText(wrid), /pw-join not started — the workflow run was cancelled/);
    assert.equal(runs.length, 5, 'every stage of the workflow has a row');
  });

  await test('gate: a check that never finishes fails the gate after the time limit instead of hanging the run', async () => {
    job({ name: 'gh-prod', produces: [{ key: 'k', check: () => ({ ok: true }) }], run: async () => {} });
    job({ name: 'gh-cons', consumes: [{ key: 'k', check: () => new Promise(() => {}) }], run: async () => {} });
    const def: WorkflowDefinition = { name: 'eh-gate-hang', jobs: [{ job: 'gh-prod' }, { job: 'gh-cons', dependsOn: ['gh-prod'] }] };
    syncWorkflow(def);
    config.gateTimeoutMs = 150;
    const t0 = Date.now();
    const { workflowRunId } = await runWorkflow(def, 'manual');
    config.gateTimeoutMs = orig.gateTimeout;
    assert.ok(Date.now() - t0 < 5000, 'the run did not hang');
    const cons = byJob(listRunsForWorkflowRun(workflowRunId!), 'gh-cons')[0];
    assert.equal(cons?.status, 'failed');
    assert.equal(cons?.outcome_reason, 'gate-failed');
    assert.match(cons?.error ?? '', /did not finish within/);
    assert.ok((cons?.gate_ms ?? 0) >= 100, 'the time spent in the gate is recorded');
  });

  await test('gate: a check that rejects asynchronously is a violation', async () => {
    job({ name: 'gr-prod', produces: [{ key: 'k', check: () => ({ ok: true }) }], run: async () => {} });
    job({ name: 'gr-cons', consumes: [{ key: 'k', check: async () => { throw new Error('async drift'); } }], run: async () => {} });
    const def: WorkflowDefinition = { name: 'eh-gate-reject', jobs: [{ job: 'gr-prod' }, { job: 'gr-cons', dependsOn: ['gr-prod'] }] };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    const cons = byJob(listRunsForWorkflowRun(workflowRunId!), 'gr-cons')[0];
    assert.equal(cons?.status, 'failed');
    assert.match(cons?.error ?? '', /input check threw — async drift/);
  });

  await test('gate: cancelling while a check is hung ends the run promptly and records the stage as not started', async () => {
    job({ name: 'gc-prod', produces: [{ key: 'k', check: () => ({ ok: true }) }], run: async () => {} });
    job({ name: 'gc-cons', consumes: [{ key: 'k', check: () => new Promise(() => {}) }], run: async () => {} });
    const def: WorkflowDefinition = { name: 'eh-gate-cancel', jobs: [{ job: 'gc-prod' }, { job: 'gc-cons', dependsOn: ['gc-prod'] }] };
    syncWorkflow(def);
    const p = runWorkflow(def, 'manual');
    const wrid = await waitActive('eh-gate-cancel');
    await waitFor('the gate check to start', () => /checking gate \[gc-prod → gc-cons\]/.test(logText(wrid)));
    const t0 = Date.now();
    cancelWorkflowRun(wrid);
    await p;
    assert.ok(Date.now() - t0 < 3000, 'cancel did not wait for the gate time limit');
    assert.equal(getWorkflowRun(wrid)?.status, 'cancelled');
    const cons = byJob(listRunsForWorkflowRun(wrid), 'gc-cons')[0];
    assert.equal(cons?.status, 'cancelled');
    assert.equal(cons?.outcome_reason, 'not-started-cancelled');
  });

  await test('gates on a fan-in: EVERY inbound gate is evaluated and recorded, not just the first failure', async () => {
    const bad = (why: string) => () => ({ ok: false, violations: [why] });
    job({ name: 'ga-p1', produces: [{ key: 'one', check: bad('one is empty') }], run: async () => {} });
    job({ name: 'ga-p2', produces: [{ key: 'two', check: () => ({ ok: true, sample: '12 rows' }) }], run: async () => {} });
    job({ name: 'ga-p3', produces: [{ key: 'three', check: bad('three is stale') }], run: async () => {} });
    job({
      name: 'ga-cons',
      consumes: [
        { key: 'one', check: () => ({ ok: true }) },
        { key: 'two', check: () => ({ ok: true }) },
        { key: 'three', check: () => ({ ok: true }) },
      ],
      run: async () => {},
    });
    const def: WorkflowDefinition = {
      name: 'eh-gate-all',
      jobs: [{ job: 'ga-p1' }, { job: 'ga-p2' }, { job: 'ga-p3' }, { job: 'ga-cons', dependsOn: ['ga-p1', 'ga-p2', 'ga-p3'] }],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    const cons = byJob(listRunsForWorkflowRun(workflowRunId!), 'ga-cons')[0];
    assert.equal(cons?.status, 'failed');
    assert.match(cons?.error ?? '', /^Gate violation \[ga-p1 → ga-cons\] artifact "one": one is empty/, 'first failure leads (classifyGates matches this prefix)');
    assert.match(cons?.error ?? '', /artifact "three": three is stale/, 'the second failure is reported too');

    const inputs = runInputsForStage(workflowRunId!, 'ga-cons');
    assert.equal(inputs.length, 3, 'one recorded verdict per inbound gate');
    const verdict = Object.fromEntries(inputs.map((i) => [i.producer_job, i.ok]));
    assert.deepEqual(verdict, { 'ga-p1': 0, 'ga-p2': 1, 'ga-p3': 0 });
    const two = inputs.find((i) => i.producer_job === 'ga-p2')!;
    assert.match(two.check_json ?? '', /12 rows/, "the check's own detail is recorded, not just pass/fail");
    assert.equal(inputs.find((i) => i.producer_job === 'ga-p1')!.reason, 'one is empty');
    assert.equal(runInputsForWorkflowRun(workflowRunId!).length, 3);
  });

  await test('retries inside a workflow: one row per attempt, the stage succeeds on the retry, run identity reaches the child', async () => {
    job({ name: 'flaky-rt', maxRetries: 2, run: async () => {} });
    job({ name: 'env-rt', run: async () => {} });
    const def: WorkflowDefinition = { name: 'eh-retry', jobs: [{ job: 'flaky-rt' }, { job: 'env-rt', dependsOn: ['flaky-rt'] }] };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'success');
    const attempts = byJob(listRunsForWorkflowRun(workflowRunId!), 'flaky-rt');
    assert.deepEqual(attempts.map((r) => [r.attempt, r.status]), [[1, 'failed'], [2, 'success']]);
    assert.ok(attempts.every((r) => r.cycle === 1 && typeof r.started_at_ms === 'number' && typeof r.finished_at_ms === 'number'));
    assert.match(getLogs(attempts[0].id).map((l) => l.message).join('\n'), /Attempt 1\/3 failed; retrying/);

    const envRun = byJob(listRunsForWorkflowRun(workflowRunId!), 'env-rt')[0];
    const line = getLogs(envRun.id).map((l) => l.message).find((m) => m.startsWith('ENV '))!;
    assert.deepEqual(JSON.parse(line.slice(4)), {
      engine: String(ENGINE_PROTOCOL), runId: envRun.id, attempt: '1', cycle: '1', wf: 'eh-retry', wfRun: workflowRunId, trigger: 'manual',
    });
  });

  await test('retry backoff: the Nth retry waits the Nth configured value, the last one repeating', async () => {
    assert.equal(retryDelayMs(1, [5, 30, 120]), 5);
    assert.equal(retryDelayMs(2, [5, 30, 120]), 30);
    assert.equal(retryDelayMs(3, [5, 30, 120]), 120);
    assert.equal(retryDelayMs(9, [5, 30, 120]), 120);
    assert.equal(retryDelayMs(1, []), 0);
  });

  await test('retry backoff is cancellable: a cancel during the wait stops the retry instead of sitting it out', async () => {
    const d = job({ name: 'fail-backoff', maxRetries: 3, run: async () => {} });
    const wf = createWorkflowRun('eh-retry', 'manual');
    config.retryBackoffMs = [60_000];
    const ac = new AbortController();
    const t0 = Date.now();
    const p = runJobForWorkflow(d, wf, ac.signal);
    await waitFor('the first attempt to fail', () => listRunsForJob('fail-backoff').some((r) => r.status === 'failed'));
    ac.abort();
    const res = await p;
    config.retryBackoffMs = orig.backoff;
    assert.equal(res.status, 'cancelled');
    assert.ok(Date.now() - t0 < 5000, 'did not wait out the 60s backoff');
    assert.equal(listRunsForJob('fail-backoff').length, 1, 'no further attempt was spawned');
  });

  await test('overlap guard: the skip is recorded as an overlap and names the run holding the job', async () => {
    const d = job({ name: 'ov-job', run: async () => {} });
    const holder = createRun('ov-job', 'manual');
    const wf = createWorkflowRun('eh-retry', 'manual');
    const res = await runJobForWorkflow(d, wf);
    assert.equal(res.status, 'skipped');
    const row = getRun(res.runId!)!;
    assert.equal(row.outcome_reason, 'overlap');
    assert.ok((row.error ?? '').includes(holder), `the reason names the holding run: ${row.error}`);
  });

  await test('child stdout that is JSON but not an event is logged, never dropped', async () => {
    const d = job({ name: 'chatty-out', run: async () => {} });
    const wf = createWorkflowRun('eh-retry', 'manual');
    const res = await runJobForWorkflow(d, wf);
    assert.equal(res.status, 'success');
    const lines = getLogs(res.runId!).map((l) => l.message);
    assert.ok(lines.includes('42'), 'a bare JSON number is logged');
    assert.ok(lines.includes('null'), 'a bare JSON null is logged');
    assert.ok(lines.some((l) => l.includes('from-the-future')), 'an unknown event type is logged');
  });

  await test('repeatUntilStable: a stage that was a noop in cycle 1 and FAILS in cycle 2 has its failure logged (noop tracking is per cycle)', async () => {
    job({ name: 'cy-root', inputKeys: () => ['k1'], run: async () => {} }); // makes the workflow limitable → noop detection on
    job({ name: 'cyclefail-stage', run: async () => {} });
    const def: WorkflowDefinition = {
      name: 'eh-cycles',
      repeatUntilStable: true,
      maxCycles: 2,
      minAttempts: 4,
      jobs: [{ job: 'cy-root' }, { job: 'cyclefail-stage', dependsOn: ['cy-root'] }],
    };
    syncWorkflow(def);
    // Retryable work in the ledger keeps the loop going into cycle 2.
    markWorkItem('cy-root', 'k1', 'failed', { attempts: 1, workflowRunId: null });
    const { workflowRunId } = await runWorkflow(def, 'manual');
    const log = logText(workflowRunId!);
    assert.match(log, /──── cycle 2\/2 ────/, 'a second cycle ran');
    assert.match(log, /cyclefail-stage → skipped \(nothing to do/, 'cycle 1: detected as a noop');
    assert.match(log, /✗ cyclefail-stage → failed/, 'cycle 2: the failure is logged, not suppressed by the stale noop flag');
    const runs = byJob(listRunsForWorkflowRun(workflowRunId!), 'cyclefail-stage');
    assert.deepEqual(runs.map((r) => [r.cycle, r.status, r.outcome_reason ?? null]), [[1, 'skipped', 'noop'], [2, 'failed', null]]);
    assert.equal(getWorkflowRun(workflowRunId!)?.cycles, 2, 'the number of cycles run is recorded');
  });

  await test('repeatUntilStable: cancelling during the pause between cycles ends the run now, not after the sleep', async () => {
    plain('cs-a');
    const def: WorkflowDefinition = {
      name: 'eh-cycle-sleep',
      repeatUntilStable: true,
      maxCycles: 3,
      cycleSleepMs: 60_000,
      jobs: [{ job: 'cs-a' }],
    };
    syncWorkflow(def);
    markWorkItem('cs-a', 'pending', 'failed', { attempts: 1, workflowRunId: null });
    const p = runWorkflow(def, 'manual');
    const wrid = await waitActive('eh-cycle-sleep');
    await waitFor('the inter-cycle sleep', () => /sleeping 60s before next cycle/.test(logText(wrid)));
    const t0 = Date.now();
    cancelWorkflowRun(wrid);
    await p;
    assert.ok(Date.now() - t0 < 3000, 'did not wait out the 60s pause');
    assert.equal(getWorkflowRun(wrid)?.status, 'cancelled');
  });

  // LAST: reaping touches every `running` row in this scratch DB.
  await test('daemon restart: a reaped run records why it ended, how long it ran, and which stages never started', async () => {
    plain('rp-a', 'rp-b', 'rp-c');
    const def: WorkflowDefinition = {
      name: 'eh-reap',
      jobs: [{ job: 'rp-a' }, { job: 'rp-b', dependsOn: ['rp-a'] }, { job: 'rp-c', dependsOn: ['rp-b'] }],
    };
    syncWorkflow(def);
    const wf = createWorkflowRun('eh-reap', 'schedule');
    const inFlight = createRun('rp-a', 'workflow', 1, wf); // was running when the daemon died

    assert.ok(reapOrphanRuns() >= 1);
    assert.ok(reapOrphanWorkflowRuns() >= 1);

    const a = getRun(inFlight)!;
    assert.equal(a.status, 'cancelled');
    assert.equal(a.outcome_reason, 'orphaned');
    assert.equal(typeof a.duration_ms, 'number', 'the reaped member has a duration');

    const run = getWorkflowRun(wf)!;
    assert.equal(run.status, 'cancelled');
    assert.equal(run.end_reason, 'orphaned by a daemon restart');
    assert.equal(typeof run.duration_ms, 'number', 'the reaped workflow run has a duration');

    const rows = listRunsForWorkflowRun(wf);
    const notStarted = rows.filter((r) => r.outcome_reason === 'orphaned' && r.job_name !== 'rp-a');
    assert.deepEqual(notStarted.map((r) => r.job_name).sort(), ['rp-b', 'rp-c'], 'stages that never started get a row');
    const log = logText(wf);
    assert.match(log, /interrupted — the daemon restarted/);
    assert.match(log, /2 stage\(s\) had not started: rp-b, rp-c/);
    assert.equal(reapOrphanWorkflowRuns(), 0, 'idempotent: nothing left to reap');
  });
} finally {
  config.runJobScript = orig.script;
  config.ntfyTopic = orig.topic;
  config.gateTimeoutMs = orig.gateTimeout;
  config.retryBackoffMs = orig.backoff;
  for (const d of pushed) {
    const i = jobs.indexOf(d);
    if (i >= 0) jobs.splice(i, 1);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} engine-hardening test(s) passed.`);
