// Unit tests for runWorkflow: aggregate status derivation, the skip cascade
// (a member whose upstream failed is recorded skipped), repeatUntilStable cycling,
// and the invalid-DAG guard. Member execution uses the same FAKE child script as
// the executor tests (config.runJobScript), so no real job runs. ntfy is force-
// disabled (empty topic) so the notifier makes no network call. Runs against the
// scratch DB (LOCALJOBS_DB).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { jobs } from '../jobs/registry.js';
import {
  createWorkflowRun, createRun, finishRun, getWorkflowLogs, getWorkflowRun, getWorkflowRunRoots,
  lastWorkflowRunForWorkflow, listRunsForWorkflowRun, markWorkItem,
  rollUpWorkflowProgress, setProgress, syncJob, syncWorkflow, updateWorkflowConcurrency, getWorkflow,
} from '../db/store.js';
import { runWorkflow, cancelWorkflowRun, isWorkflowRunActive, workflowRunInProgress, effectiveWorkflowConcurrency, UNLIMITED_CONCURRENCY_SENTINEL } from './workflow-executor.js';
import { _setFetchForTest, _resetFetchForTest } from './notifier.js';
import type { JobDefinition, WorkflowDefinition } from './types.js';

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

// Minimal fake child: names starting 'timeout' HANG (wait to be killed), names
// starting 'fail' emit a failed result, names starting 'slow' succeed after a
// fixed delay (so concurrency can be observed by wall-time overlap); anything else
// succeeds immediately.
const SLOW_MS = 250;
const FAKE = `
const name = process.argv[2] ?? '';
const done = (o, code) => process.stdout.write(JSON.stringify(o) + '\\n', () => process.exit(code));
if (name.startsWith('timeout')) setTimeout(() => {}, 60000); // hang until killed
else if (name.startsWith('fail')) done({ type: 'result', status: 'failed', error: 'planned failure' }, 1);
else if (name.startsWith('slow')) setTimeout(() => done({ type: 'result', status: 'success' }, 0), ${SLOW_MS});
else done({ type: 'result', status: 'success' }, 0);
`;

const dir = mkdtempSync(join(tmpdir(), 'lj-pipe-'));
const fakePath = join(dir, 'fake-runner.mjs');
writeFileSync(fakePath, FAKE);

const origScript = config.runJobScript;
const origTopic = config.ntfyTopic;
config.runJobScript = fakePath;
config.ntfyTopic = ''; // never POST to ntfy during tests

// Member jobs must be discoverable (getJobDefinition) AND exist in the jobs table (FK).
const members = ['pp-a', 'pp-b', 'fail-pp-a', 'pp-dep', 'rus-a', 'ru-a', 'ru-b', 'ru-c', 'ru-d', 'timeout-cancel-pp', 'pp-after-cancel', 'timeout-guard-a', 'timeout-guard-b', 'slow-a', 'slow-b', 'slow-c', 'slow-d'];
const pushed: JobDefinition[] = [];
for (const name of members) {
  const d: JobDefinition = { name, run: async () => {} };
  syncJob(d);
  jobs.push(d);
  pushed.push(d);
}

// Gate members: a producer + several consumers wired with typed-artifact contracts.
// `check` is synchronous and deterministic (no I/O, no real artifacts) so the gate
// logic is exercised in isolation. `g-prod-bad` has a FAILING produces contract.
const ok = () => ({ ok: true, detail: 'fixture ok' });
const bad = (...violations: string[]) => () => ({ ok: false, violations });
const gateMembers: JobDefinition[] = [
  { name: 'g-prod', produces: [{ key: 'csv', check: ok }], run: async () => {} },
  { name: 'g-prod-bad', produces: [{ key: 'csv', check: bad("missing column 'cid'", 'header drifted') }], run: async () => {} },
  { name: 'g-cons-ok', consumes: [{ key: 'csv', check: ok }], run: async () => {} },
  { name: 'g-cons-bad', consumes: [{ key: 'csv', check: bad('row 3 has no place_id') }], run: async () => {} },
  { name: 'g-cons-throw', consumes: [{ key: 'csv', check: () => { throw new Error('page structure changed'); } }], run: async () => {} },
  // Described contracts: the executor must log WHAT the gate asserts (the contract
  // descriptions), not just pass/fail, into the workflow run's framework log.
  { name: 'g-prod-desc', produces: [{ key: 'csv', description: 'CSV has cid + name columns', check: ok }], run: async () => {} },
  { name: 'g-cons-desc', consumes: [{ key: 'csv', description: 'every row has a place_id', check: ok }], run: async () => {} },
];
for (const d of gateMembers) {
  syncJob(d);
  jobs.push(d);
  pushed.push(d);
}

// Asymmetric-gate members (T138): the producer's `produces[key]` and the
// consumer's `consumes[key]` declare DIFFERENT shapes and SEPARATE checks. The
// counters prove the executor runs BOTH sides independently at the boundary, so
// fan-in / asymmetric DAGs are genuinely supported (not just the one-factory case).
let asymProdChecks = 0;
let asymConsChecks = 0;
const asymProdShape = { summary: 'raw producer view', format: 'csv', expectations: [{ label: 'has header row' }] };
const asymConsShape = { summary: 'parsed consumer view', format: 'objects', expectations: [{ label: 'every row has an id' }] };
const asymMembers: JobDefinition[] = [
  { name: 'asym-prod', produces: [{ key: 'sym', shape: asymProdShape, check: () => { asymProdChecks++; return { ok: true }; } }], run: async () => {} },
  { name: 'asym-cons-ok', consumes: [{ key: 'sym', shape: asymConsShape, check: () => { asymConsChecks++; return { ok: true }; } }], run: async () => {} },
  { name: 'asym-cons-bad', consumes: [{ key: 'sym', shape: asymConsShape, check: () => { asymConsChecks++; return { ok: false, violations: ['row 2 has no id'] }; } }], run: async () => {} },
];
for (const d of asymMembers) {
  syncJob(d);
  jobs.push(d);
  pushed.push(d);
}

// Run-limit members (T094): a root stage that declares inputKeys() + a consumer.
// The fake child just succeeds — selection happens in the PARENT at run start, so
// these prove run_limit + selected_roots are frozen on the run row correctly.
const limitMembers: JobDefinition[] = [
  { name: 'lim-root', inputKeys: () => ['k1', 'k2', 'k3', 'k4'], run: async () => {} },
  { name: 'lim-cons', run: async () => {} },
  // T163: a separate entry+terminal pair whose ledger we pre-seed to model a
  // backlog (entry done, terminal not yet attempted) and an all-complete set.
  { name: 't163-root', inputKeys: () => ['j1', 'j2', 'j3'], run: async () => {} },
  { name: 't163-cons', run: async () => {} },
];
for (const d of limitMembers) {
  syncJob(d);
  jobs.push(d);
  pushed.push(d);
}

// T258 noop-detection members: a limitable workflow (root stage has inputKeys).
// The fake child succeeds but never calls markWorkItem, so every run appears to
// advance nothing → status 'skipped' (noop).
const t258Members: JobDefinition[] = [
  { name: 't258-stage-a', inputKeys: () => ['x1', 'x2'], run: async () => {} },
  { name: 't258-stage-b', run: async () => {} },
];
for (const d of t258Members) {
  syncJob(d);
  jobs.push(d);
  pushed.push(d);
}

try {
  await test('all members succeed → aggregate status success', async () => {
    const def: WorkflowDefinition = { name: 'pp-success', jobs: [{ job: 'pp-a' }, { job: 'pp-b', dependsOn: ['pp-a'] }] };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    assert.ok(workflowRunId);
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'success');
    assert.equal(getWorkflowRun(workflowRunId!)?.progress, 100, 'all stages done → 100%');
    const memberRuns = listRunsForWorkflowRun(workflowRunId!);
    assert.equal(memberRuns.length, 2);
    assert.ok(memberRuns.every((r) => r.status === 'success'));
  });

  await test('progress roll-up: workflow % counts only completed stages over the total stage count (no in-flight partial credit)', async () => {
    // Four independent stages → denominator 4. We drive member runs directly
    // (no spawn) to assert the roll-up math across mixed stage states.
    const def: WorkflowDefinition = {
      name: 'pp-rollup', jobs: [{ job: 'ru-a' }, { job: 'ru-b' }, { job: 'ru-c' }, { job: 'ru-d' }],
    };
    syncWorkflow(def);
    const prid = createWorkflowRun('pp-rollup', 'manual');

    // No member runs yet → 0%.
    assert.equal(rollUpWorkflowProgress(prid), 0);

    // Stage ru-a completes (terminal) → counts as a full stage: 1/4 = 25%.
    const aRun = createRun('ru-a', 'workflow', 1, prid);
    finishRun(aRun, 'success', { exitCode: 0 });
    assert.equal(rollUpWorkflowProgress(prid), 25);

    // Stage ru-b starts and reports 50% — an in-flight member earns NO partial
    // credit, so the bar stays at 25% (only ru-a has completed).
    const bRun = createRun('ru-b', 'workflow', 1, prid);
    createRun('ru-c', 'workflow', 1, prid); // ru-c running at 0% contributes nothing
    setProgress(bRun, 50, 'halfway');
    assert.equal(getWorkflowRun(prid)?.progress, 25, 'mid-stage member progress does NOT move the bar');

    // ru-b finishes (terminal) → 2/4 = 50% (a whole-stage step); ru-d never started.
    finishRun(bRun, 'success', { exitCode: 0 });
    assert.equal(rollUpWorkflowProgress(prid), 50);
  });

  await test('a failed upstream skips its dependent → status failed (no member succeeded), dependent recorded skipped', async () => {
    const def: WorkflowDefinition = { name: 'pp-partial', jobs: [{ job: 'fail-pp-a' }, { job: 'pp-dep', dependsOn: ['fail-pp-a'] }] };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'failed');
    const memberRuns = listRunsForWorkflowRun(workflowRunId!);
    assert.ok(memberRuns.some((r) => r.job_name === 'fail-pp-a' && r.status === 'failed'));
    const skipped = memberRuns.find((r) => r.job_name === 'pp-dep');
    assert.equal(skipped?.status, 'skipped'); // never spawned — recorded by the skip cascade
  });

  await test('status rollup: all-success → success; mixed success+failure → partial; no success → failed', async () => {
    // all success
    const defOk: WorkflowDefinition = { name: 'rollup-ok', jobs: [{ job: 'pp-a' }, { job: 'pp-b' }] };
    syncWorkflow(defOk);
    const { workflowRunId: okId } = await runWorkflow(defOk, 'manual');
    assert.equal(getWorkflowRun(okId!)?.status, 'success', 'all succeed → success');

    // first stage fails, second is skipped (depends on first) → no successes → failed
    const defAllFail: WorkflowDefinition = { name: 'rollup-fail', jobs: [{ job: 'fail-pp-a' }, { job: 'pp-dep', dependsOn: ['fail-pp-a'] }] };
    syncWorkflow(defAllFail);
    const { workflowRunId: failId } = await runWorkflow(defAllFail, 'manual');
    assert.equal(getWorkflowRun(failId!)?.status, 'failed', 'no stage succeeded → failed (not partial)');

    // first stage succeeds, second fails independently → partial
    const defMixed: WorkflowDefinition = { name: 'rollup-mixed', jobs: [{ job: 'pp-a' }, { job: 'fail-pp-a' }] };
    syncWorkflow(defMixed);
    const { workflowRunId: mixId } = await runWorkflow(defMixed, 'manual');
    assert.equal(getWorkflowRun(mixId!)?.status, 'partial', 'some succeeded, some failed → partial');
  });

  await test('repeatUntilStable: cycles repeat while retryable work remains (up to maxCycles)', async () => {
    // Seed a permanently-retryable work item (failed, attempts < minAttempts) so the
    // workflow never reaches "stable" and runs the full maxCycles.
    markWorkItem('rus-a', 'seed-key', 'failed', { attempts: 1 });
    const def: WorkflowDefinition = {
      name: 'pp-repeat', jobs: [{ job: 'rus-a' }], repeatUntilStable: true, maxCycles: 2, cycleSleepMs: 0,
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    const logText = getWorkflowLogs(workflowRunId!).map((l) => l.message).join('\n');
    assert.ok(/cycle 1\/2/.test(logText), 'cycle 1 ran');
    assert.ok(/cycle 2\/2/.test(logText), 'cycle 2 ran (retryable work kept it going)');
    assert.ok(/retryable work left = 1/.test(logText), 'reported the outstanding retryable work');
    // member ran once per cycle
    assert.equal(listRunsForWorkflowRun(workflowRunId!).filter((r) => r.job_name === 'rus-a').length, 2);
  });

  await test('invalid DAG (cycle) → no members run, run finished failed with an error log', async () => {
    const def: WorkflowDefinition = {
      name: 'pp-cyclic',
      jobs: [{ job: 'pp-a', dependsOn: ['pp-b'] }, { job: 'pp-b', dependsOn: ['pp-a'] }],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    assert.ok(workflowRunId);
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'failed');
    assert.equal(listRunsForWorkflowRun(workflowRunId!).length, 0); // never got to running members
    const logText = getWorkflowLogs(workflowRunId!).map((l) => l.message).join('\n');
    assert.ok(/Invalid workflow DAG/.test(logText), `logs were: ${logText}`);
  });

  await test('validation gate: a satisfied contract lets the consumer run → success', async () => {
    const def: WorkflowDefinition = {
      name: 'gate-pass', jobs: [{ job: 'g-prod' }, { job: 'g-cons-ok', dependsOn: ['g-prod'] }],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'success');
    const runs = listRunsForWorkflowRun(workflowRunId!);
    assert.ok(runs.every((r) => r.status === 'success'), 'both stages ran and succeeded');
    const logText = getWorkflowLogs(workflowRunId!).map((l) => l.message).join('\n');
    assert.ok(/1 gate\(s\)/.test(logText), 'gate count surfaced in the start log');
    assert.ok(/gate ok \[g-prod → g-cons-ok\] artifact "csv"/.test(logText), `gate-ok not logged: ${logText}`);
  });

  await test('validation gate: the executor logs each gate check WITH what it asserts (contract descriptions)', async () => {
    const def: WorkflowDefinition = {
      name: 'gate-logging', jobs: [{ job: 'g-prod-desc' }, { job: 'g-cons-desc', dependsOn: ['g-prod-desc'] }],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'success');
    const logText = getWorkflowLogs(workflowRunId!).map((l) => l.message).join('\n');
    // The "checking" line names the boundary, the artifact, AND both assertions.
    assert.match(logText, /checking gate \[g-prod-desc → g-cons-desc\] artifact "csv"/, `checking line missing: ${logText}`);
    assert.match(logText, /output \(from g-prod-desc\): CSV has cid \+ name columns/, `output assertion not logged: ${logText}`);
    assert.match(logText, /input \(to g-cons-desc\): every row has a place_id/, `input assertion not logged: ${logText}`);
    // …and the pass result is still logged with the same assertion suffix.
    assert.match(logText, /✓ gate ok \[g-prod-desc → g-cons-desc\] artifact "csv".*every row has a place_id/, `gate-ok result missing: ${logText}`);
  });

  await test('validation gate: a CONSUMER-side drift fails the gate → consumer never runs, status partial', async () => {
    const def: WorkflowDefinition = {
      name: 'gate-fail-consumer', jobs: [{ job: 'g-prod' }, { job: 'g-cons-bad', dependsOn: ['g-prod'] }],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'partial');
    const runs = listRunsForWorkflowRun(workflowRunId!);
    assert.ok(runs.some((r) => r.job_name === 'g-prod' && r.status === 'success'), 'producer ran first');
    const cons = runs.find((r) => r.job_name === 'g-cons-bad');
    assert.equal(cons?.status, 'failed'); // first-class failed run — NOT skipped
    assert.match(cons!.error ?? '', /Gate violation/);
    assert.match(cons!.error ?? '', /row 3 has no place_id/); // exact drift surfaced
  });

  await test('validation gate: a PRODUCER-side drift fails the gate before the consumer runs', async () => {
    const def: WorkflowDefinition = {
      name: 'gate-fail-producer', jobs: [{ job: 'g-prod-bad' }, { job: 'g-cons-ok', dependsOn: ['g-prod-bad'] }],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'partial');
    const cons = listRunsForWorkflowRun(workflowRunId!).find((r) => r.job_name === 'g-cons-ok');
    assert.equal(cons?.status, 'failed');
    assert.match(cons!.error ?? '', /missing column 'cid'/);
  });

  await test('validation gate: a contract that THROWS is treated as a violation, not a crash', async () => {
    const def: WorkflowDefinition = {
      name: 'gate-fail-throw', jobs: [{ job: 'g-prod' }, { job: 'g-cons-throw', dependsOn: ['g-prod'] }],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'partial');
    const cons = listRunsForWorkflowRun(workflowRunId!).find((r) => r.job_name === 'g-cons-throw');
    assert.equal(cons?.status, 'failed');
    assert.match(cons!.error ?? '', /check threw — page structure changed/);
  });

  await test('validation gate: a gate failure CASCADES — the consumer\'s own dependents are skipped', async () => {
    const def: WorkflowDefinition = {
      name: 'gate-cascade',
      jobs: [
        { job: 'g-prod' },
        { job: 'g-cons-bad', dependsOn: ['g-prod'] },
        { job: 'pp-dep', dependsOn: ['g-cons-bad'] },
      ],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    const runs = listRunsForWorkflowRun(workflowRunId!);
    assert.equal(runs.find((r) => r.job_name === 'g-cons-bad')?.status, 'failed');
    assert.equal(runs.find((r) => r.job_name === 'pp-dep')?.status, 'skipped'); // downstream of the gated stage
  });
  await test('asymmetric gate: producer/consumer declare DIFFERENT shapes → BOTH checks run and the consumer passes', async () => {
    asymProdChecks = 0; asymConsChecks = 0;
    const def: WorkflowDefinition = {
      name: 'asym-pass', jobs: [{ job: 'asym-prod' }, { job: 'asym-cons-ok', dependsOn: ['asym-prod'] }],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'success');
    assert.equal(asymProdChecks, 1, 'producer-side contract was checked');
    assert.equal(asymConsChecks, 1, 'consumer-side (different shape) contract was checked');
  });

  await test('asymmetric gate: a consumer-side drift fails the gate independently of the (ok) producer side', async () => {
    asymProdChecks = 0; asymConsChecks = 0;
    const def: WorkflowDefinition = {
      name: 'asym-fail', jobs: [{ job: 'asym-prod' }, { job: 'asym-cons-bad', dependsOn: ['asym-prod'] }],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    const cons = listRunsForWorkflowRun(workflowRunId!).find((r) => r.job_name === 'asym-cons-bad');
    assert.equal(cons?.status, 'failed');
    assert.match(cons!.error ?? '', /Gate violation/);
    assert.match(cons!.error ?? '', /row 2 has no id/);
    assert.equal(asymProdChecks, 1, 'producer-side still checked even though the consumer drifted');
  });

  await test('run-limit: a manual limit selects the first N roots and freezes them on the run row', async () => {
    const def: WorkflowDefinition = {
      name: 'lim-wf', jobs: [{ job: 'lim-root' }, { job: 'lim-cons', dependsOn: ['lim-root'] }],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual', { limit: 2 });
    assert.ok(workflowRunId);
    assert.equal(getWorkflowRun(workflowRunId!)?.run_limit, 2, 'run_limit persisted on the row');
    assert.deepEqual(getWorkflowRunRoots(workflowRunId!), ['k1', 'k2'], 'first 2 pending roots selected (input order)');
    const logText = getWorkflowLogs(workflowRunId!).map((l) => l.message).join('\n');
    assert.match(logText, /limited to 2 originating input\(s\): k1, k2/, `limit not logged: ${logText}`);
  });

  await test('run-limit: an unlimited manual run leaves run_limit + selected_roots null (today\'s behaviour)', async () => {
    const def: WorkflowDefinition = {
      name: 'lim-wf-unl', jobs: [{ job: 'lim-root' }, { job: 'lim-cons', dependsOn: ['lim-root'] }],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    assert.equal(getWorkflowRun(workflowRunId!)?.run_limit, null, 'no limit → run_limit null');
    assert.equal(getWorkflowRunRoots(workflowRunId!), null, 'no limit → no allowlist');
  });

  await test('run-limit T163: a backlog (entry done, terminal un-attempted) selects those roots — not 0', async () => {
    // Model resolved-but-not-enriched: the entry stage is done for j1/j2 but the
    // TERMINAL stage has NO row → pre-fix the selector treated them as "done" and
    // selected 0 (or skipped to fresh roots). They must now be selected.
    markWorkItem('t163-root', 'j1', 'success', { rootKey: 'j1' });
    markWorkItem('t163-root', 'j2', 'success', { rootKey: 'j2' });
    const def: WorkflowDefinition = {
      name: 't163-backlog', jobs: [{ job: 't163-root' }, { job: 't163-cons', dependsOn: ['t163-root'] }],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual', { limit: 2 });
    assert.deepEqual(getWorkflowRunRoots(workflowRunId!), ['j1', 'j2'], 'entry-done-but-terminal-un-attempted roots ARE selected');
    const logText = getWorkflowLogs(workflowRunId!).map((l) => l.message).join('\n');
    assert.doesNotMatch(logText, /0 originating inputs were selectable/, 'no empty-selection warning when work exists');
  });

  await test('run-limit T163: a limit that selects 0 roots from a non-empty candidate set logs a clear WARNING', async () => {
    // Make EVERY candidate fully propagated to the terminal stage → nothing selectable.
    for (const k of ['j1', 'j2', 'j3']) {
      markWorkItem('t163-root', k, 'success', { rootKey: k });
      markWorkItem('t163-cons', `${k}-out`, 'success', { rootKey: k });
    }
    const def: WorkflowDefinition = {
      name: 't163-allcomplete', jobs: [{ job: 't163-root' }, { job: 't163-cons', dependsOn: ['t163-root'] }],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual', { limit: 2 });
    assert.deepEqual(getWorkflowRunRoots(workflowRunId!), [], 'all complete → 0 selected');
    const logText = getWorkflowLogs(workflowRunId!).map((l) => l.message).join('\n');
    assert.match(logText, /0 originating inputs were selectable — 3 candidate\(s\)/, `empty-selection warning missing: ${logText}`);
  });

  await test('run-limit: a SCHEDULED run is never limited even when a root stage exists', async () => {
    const def: WorkflowDefinition = {
      name: 'lim-wf-sched', jobs: [{ job: 'lim-root' }, { job: 'lim-cons', dependsOn: ['lim-root'] }],
    };
    syncWorkflow(def);
    // The scheduler calls runWorkflow(def, 'schedule') with NO opts → unlimited.
    const { workflowRunId } = await runWorkflow(def, 'schedule');
    assert.equal(getWorkflowRun(workflowRunId!)?.run_limit, null, 'scheduled run stays unlimited');
    assert.equal(getWorkflowRunRoots(workflowRunId!), null, 'scheduled run has no allowlist');
  });

  await test('cancellation: aborting a running workflow kills the in-flight stage, launches no more, marks cancelled', async () => {
    const def: WorkflowDefinition = {
      name: 'pp-cancel',
      jobs: [{ job: 'timeout-cancel-pp' }, { job: 'pp-after-cancel', dependsOn: ['timeout-cancel-pp'] }],
    };
    syncWorkflow(def);
    // Start the run but don't await — its first stage hangs (timeout-* fake).
    const runPromise = runWorkflow(def, 'manual');

    // Wait until the workflow run row exists and is running, then cancel it.
    const deadline = Date.now() + 5000;
    let wrid: string | undefined;
    while (Date.now() < deadline) {
      const r = lastWorkflowRunForWorkflow('pp-cancel');
      if (r && r.status === 'running' && isWorkflowRunActive(r.id)) { wrid = r.id; break; }
      await new Promise((res) => setTimeout(res, 25));
    }
    assert.ok(wrid, 'workflow run became active');
    assert.equal(cancelWorkflowRun(wrid!), true, 'cancel found the active run');

    const { workflowRunId } = await runPromise;
    assert.equal(workflowRunId, wrid);
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'cancelled', 'workflow run marked cancelled');

    const runs = listRunsForWorkflowRun(workflowRunId!);
    const killed = runs.find((r) => r.job_name === 'timeout-cancel-pp');
    assert.equal(killed?.status, 'cancelled', 'the in-flight member was killed and recorded cancelled');
    // The downstream stage never spawned (no row at all) — cancel stops launching.
    assert.equal(runs.find((r) => r.job_name === 'pp-after-cancel'), undefined, 'no further stage launched');
    // Registry cleaned up after the run settled.
    assert.equal(isWorkflowRunActive(workflowRunId!), false, 'registry entry removed on settle');
    // A second cancel of a now-terminal run is a no-op (returns false).
    assert.equal(cancelWorkflowRun(workflowRunId!), false, 'cancelling a settled run returns false');
  });

  await test('one active run per workflow (T105): a second start of the SAME workflow is refused; a DIFFERENT workflow still starts', async () => {
    const wfA: WorkflowDefinition = { name: 'guard-wf-a', jobs: [{ job: 'timeout-guard-a' }] };
    const wfB: WorkflowDefinition = { name: 'guard-wf-b', jobs: [{ job: 'timeout-guard-b' }] };
    syncWorkflow(wfA);
    syncWorkflow(wfB);

    // Start A but don't await — its only stage hangs (timeout-* fake), so the run
    // stays 'running'.
    const runA = runWorkflow(wfA, 'manual');
    const deadline = Date.now() + 5000;
    let aid: string | undefined;
    while (Date.now() < deadline) {
      const r = lastWorkflowRunForWorkflow('guard-wf-a');
      if (r && r.status === 'running' && isWorkflowRunActive(r.id)) { aid = r.id; break; }
      await new Promise((res) => setTimeout(res, 25));
    }
    assert.ok(aid, 'workflow A became active');
    assert.equal(workflowRunInProgress('guard-wf-a'), true, 'guard reports A in progress');

    // A second start of the SAME workflow is refused (skipped), no new run row.
    const dup = await runWorkflow(wfA, 'manual');
    assert.equal(dup.workflowRunId, null, 'duplicate start returns no run id');
    assert.equal(dup.skipped, true, 'duplicate start is skipped');
    assert.equal(lastWorkflowRunForWorkflow('guard-wf-a')!.id, aid, 'no second run row was created for A');

    // A DIFFERENT workflow can still start while A is running (per-workflow, not global).
    assert.equal(workflowRunInProgress('guard-wf-b'), false, 'B is not in progress before its start');
    const runB = runWorkflow(wfB, 'manual');
    let bid: string | undefined;
    while (Date.now() < deadline) {
      const r = lastWorkflowRunForWorkflow('guard-wf-b');
      if (r && r.status === 'running' && isWorkflowRunActive(r.id)) { bid = r.id; break; }
      await new Promise((res) => setTimeout(res, 25));
    }
    assert.ok(bid, 'a DIFFERENT workflow started while A was still running');

    // Clean up: cancel both hanging runs and await their settlement.
    cancelWorkflowRun(aid!);
    cancelWorkflowRun(bid!);
    await Promise.all([runA, runB]);
    // Guard released once each run settled.
    assert.equal(workflowRunInProgress('guard-wf-a'), false, 'A guard released after settle');
    assert.equal(workflowRunInProgress('guard-wf-b'), false, 'B guard released after settle');
  });

  await test('parallelism (T156): independent stages run concurrently by DEFAULT; maxConcurrency:1 forces sequential; a dependent still waits', async () => {
    // We compare wall-times of the SAME 4 slow stages under three shapes. Absolute
    // ms is machine-dependent (each child pays a `--import tsx` startup cost), so we
    // assert RELATIONSHIPS between the measured times, which are robust to speed:
    // the constant per-process startup inflates the serial run ~4× but the
    // concurrent run only ~1×.
    const time = async (def: WorkflowDefinition) => {
      syncWorkflow(def);
      const t0 = Date.now();
      const { workflowRunId } = await runWorkflow(def, 'manual');
      const elapsed = Date.now() - t0;
      assert.equal(getWorkflowRun(workflowRunId!)?.status, 'success', `${def.name} succeeded`);
      assert.equal(
        listRunsForWorkflowRun(workflowRunId!).filter((r) => r.status === 'success').length,
        def.jobs.length,
        `${def.name}: all ${def.jobs.length} stages succeeded`,
      );
      return elapsed;
    };

    // Default (cap 4): all four independent stages ready at once → run together.
    const parDefault = await time({
      name: 'par-default',
      jobs: [{ job: 'slow-a' }, { job: 'slow-b' }, { job: 'slow-c' }, { job: 'slow-d' }],
    });
    // Override cap 1: the SAME four stages, forced one-at-a-time.
    const parSerial = await time({
      name: 'par-serial',
      jobs: [{ job: 'slow-a' }, { job: 'slow-b' }, { job: 'slow-c' }, { job: 'slow-d' }],
      maxConcurrency: 1,
    });
    // Dependency gate: three parallel deps + one dependent that must wait for all
    // three → two sequential waves.
    const parDep = await time({
      name: 'par-dep',
      jobs: [
        { job: 'slow-a' }, { job: 'slow-b' }, { job: 'slow-c' },
        { job: 'slow-d', dependsOn: ['slow-a', 'slow-b', 'slow-c'] },
      ],
    });

    // The override is honoured: forcing sequential is MUCH slower than the default
    // concurrent run (≈4 stacked stages vs ≈1) — proving the default overlaps and
    // `maxConcurrency:1` serialises. Generous ratio to stay robust under CI load.
    assert.ok(
      parDefault * 1.8 < parSerial,
      `default-concurrency run (${parDefault}ms) should be far faster than serial (${parSerial}ms)`,
    );
    // The serial run took roughly the SUM of all four slow stages — at least three
    // of them clearly did NOT overlap.
    assert.ok(parSerial > SLOW_MS * 3, `serial run should be ≥ ~4 stacked stages, took ${parSerial}ms`);
    // The dependent waits: two waves (parallel deps, then the dependent) takes
    // measurably longer than the single-wave default, yet stays well under the
    // fully-serial run — so the three deps overlapped AND the dependent waited.
    assert.ok(parDep > parDefault, `dependent must add a second wave (${parDep}ms > ${parDefault}ms)`);
    assert.ok(parDep < parSerial, `the three deps must still overlap (${parDep}ms < serial ${parSerial}ms)`);
  });

  // T189: notifyStage is never called; notifyWorkflow is called exactly once.
  // We enable ntfy temporarily and intercept fetch to count push calls by title.
  await test('T189: only notifyWorkflow fires — no per-stage push notifications', async () => {
    const def: WorkflowDefinition = {
      name: 't189-notify',
      jobs: [{ job: 'pp-a' }, { job: 'pp-b', dependsOn: ['pp-a'] }],
    };
    syncWorkflow(def);

    const pushTitles: string[] = [];
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const title = (init?.headers as Record<string, string>)?.['Title'] ?? '';
      pushTitles.push(title);
      return new Response('', { status: 200 });
    };

    _setFetchForTest(fakeFetch as typeof fetch);
    config.ntfyTopic = 'test-topic';
    try {
      await runWorkflow(def, 'manual');
    } finally {
      config.ntfyTopic = '';
      _resetFetchForTest();
    }

    // No per-stage push: titles must not contain ': pp-' (the notifyStage pattern)
    const stagePushes = pushTitles.filter(t => t.includes(': pp-'));
    assert.equal(stagePushes.length, 0, `Expected no per-stage pushes, got: ${JSON.stringify(stagePushes)}`);

    // Exactly one aggregate push (notifyWorkflow)
    const workflowPushes = pushTitles.filter(t => t.includes('t189-notify workflow'));
    assert.equal(workflowPushes.length, 1, `Expected 1 workflow push, got: ${JSON.stringify(pushTitles)}`);
  });

  // T201: unlimited concurrency sentinel (0) round-trip.
  await test('T201: effectiveWorkflowConcurrency returns Infinity for sentinel 0', async () => {
    const def: WorkflowDefinition = { name: 'unlim-eff-test', jobs: [{ job: 'pp-a' }], maxConcurrency: 0 };
    syncWorkflow(def);
    assert.equal(effectiveWorkflowConcurrency(def), Infinity, 'manifest maxConcurrency=0 → Infinity');
  });

  await test('T201: updateWorkflowConcurrency persists sentinel 0 and effectiveWorkflowConcurrency returns Infinity', async () => {
    const def: WorkflowDefinition = { name: 'unlim-store-test', jobs: [{ job: 'pp-a' }] };
    syncWorkflow(def);
    // Starts with default cap.
    assert.equal(effectiveWorkflowConcurrency(def), 4, 'default cap before override');
    // Set unlimited via sentinel.
    updateWorkflowConcurrency('unlim-store-test', UNLIMITED_CONCURRENCY_SENTINEL);
    assert.equal(getWorkflow('unlim-store-test')?.max_concurrency, 0, 'stored sentinel is 0');
    assert.equal(getWorkflow('unlim-store-test')?.max_concurrency_overridden, 1, 'override flag set');
    assert.equal(effectiveWorkflowConcurrency(def), Infinity, 'effective cap is Infinity after sentinel stored');
  });

  await test('T201: updateWorkflowConcurrency rejects invalid values', async () => {
    const def: WorkflowDefinition = { name: 'unlim-invalid-test', jobs: [{ job: 'pp-a' }] };
    syncWorkflow(def);
    assert.throws(() => updateWorkflowConcurrency('unlim-invalid-test', -1), /unlimited/i);
    assert.throws(() => updateWorkflowConcurrency('unlim-invalid-test', 1.5), /unlimited/i);
  });

  await test('T201: unlimited workflow runs all independent stages without throttling', async () => {
    const def: WorkflowDefinition = {
      name: 'unlim-run-test',
      jobs: [{ job: 'slow-a' }, { job: 'slow-b' }, { job: 'slow-c' }, { job: 'slow-d' }],
      maxConcurrency: 0,
    };
    syncWorkflow(def);
    const t0 = Date.now();
    const { workflowRunId } = await runWorkflow(def, 'manual');
    const elapsed = Date.now() - t0;
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'success');
    // All four slow stages should have overlapped — elapsed should be well under 4×SLOW_MS.
    assert.ok(elapsed < SLOW_MS * 3, `unlimited run with 4 slow stages should overlap, took ${elapsed}ms (expected < ${SLOW_MS * 3}ms)`);
  });

  // T258: noop status — a limitable workflow where no stage advances any work items
  // settles as 'skipped' (noop), not 'success'. The fake child succeeds but never
  // calls markWorkItem, so work_item_runs has no rows for this run → noop detected.
  await test('T258: limitable workflow where no stage advances items → status skipped (noop)', async () => {
    const def: WorkflowDefinition = {
      name: 't258-noop-wf',
      jobs: [{ job: 't258-stage-a' }, { job: 't258-stage-b', dependsOn: ['t258-stage-a'] }],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    assert.ok(workflowRunId);
    // The workflow run itself must be 'skipped' — nothing was advanced.
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'skipped', 'limitable workflow advancing nothing → skipped (T258)');
    // The member runs must have been individually marked 'skipped' by setRunNoop.
    const memberRuns = listRunsForWorkflowRun(workflowRunId!);
    assert.ok(memberRuns.every((r) => r.status === 'skipped'), 'every member run status is skipped (setRunNoop)');
    // The framework log must include the noop explanation.
    const logText = getWorkflowLogs(workflowRunId!).map((l) => l.message).join('\n');
    assert.match(logText, /nothing to do — all items already processed/, `noop log missing: ${logText}`);
  });

  await test('T258: non-limitable workflow (no inputKeys) still settles success even with no work_item_runs', async () => {
    // pp-a and pp-b have no inputKeys → isLimitableWorkflow = false → noop detection
    // is never applied → workflow settles success as before.
    const def: WorkflowDefinition = {
      name: 't258-nonlim-wf',
      jobs: [{ job: 'pp-a' }, { job: 'pp-b', dependsOn: ['pp-a'] }],
    };
    syncWorkflow(def);
    const { workflowRunId } = await runWorkflow(def, 'manual');
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'success', 'non-limitable workflow still success (T258 guard)');
  });

} finally {
  config.runJobScript = origScript;
  config.ntfyTopic = origTopic;
  for (const d of pushed) {
    const i = jobs.indexOf(d);
    if (i >= 0) jobs.splice(i, 1);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} workflow-executor test(s) passed.`);
