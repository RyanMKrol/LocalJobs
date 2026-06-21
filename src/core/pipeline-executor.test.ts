// Unit tests for runPipeline: aggregate status derivation, the skip cascade
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
  createPipelineRun, createRun, finishRun, getPipelineLogs, getPipelineRun,
  listRunsForPipelineRun, markWorkItem, rollUpPipelineProgress, setProgress,
  syncJob, syncPipeline,
} from '../db/store.js';
import { runPipeline } from './pipeline-executor.js';
import type { JobDefinition, PipelineDefinition } from './types.js';

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

// Minimal fake child: names starting 'fail' emit a failed result; anything else succeeds.
const FAKE = `
const name = process.argv[2] ?? '';
const done = (o, code) => process.stdout.write(JSON.stringify(o) + '\\n', () => process.exit(code));
if (name.startsWith('fail')) done({ type: 'result', status: 'failed', error: 'planned failure' }, 1);
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
const members = ['pp-a', 'pp-b', 'fail-pp-a', 'pp-dep', 'rus-a', 'ru-a', 'ru-b', 'ru-c', 'ru-d'];
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
];
for (const d of gateMembers) {
  syncJob(d);
  jobs.push(d);
  pushed.push(d);
}

try {
  await test('all members succeed → aggregate status success', async () => {
    const def: PipelineDefinition = { name: 'pp-success', jobs: [{ job: 'pp-a' }, { job: 'pp-b', dependsOn: ['pp-a'] }] };
    syncPipeline(def);
    const { pipelineRunId } = await runPipeline(def, 'manual');
    assert.ok(pipelineRunId);
    assert.equal(getPipelineRun(pipelineRunId!)?.status, 'success');
    assert.equal(getPipelineRun(pipelineRunId!)?.progress, 100, 'all stages done → 100%');
    const memberRuns = listRunsForPipelineRun(pipelineRunId!);
    assert.equal(memberRuns.length, 2);
    assert.ok(memberRuns.every((r) => r.status === 'success'));
  });

  await test('progress roll-up: pipeline % is computed from member progress over the total stage count, in real time', async () => {
    // Four independent stages → denominator 4. We drive member runs directly
    // (no spawn) to assert the roll-up math across mixed stage states.
    const def: PipelineDefinition = {
      name: 'pp-rollup', jobs: [{ job: 'ru-a' }, { job: 'ru-b' }, { job: 'ru-c' }, { job: 'ru-d' }],
    };
    syncPipeline(def);
    const prid = createPipelineRun('pp-rollup', 'manual');

    // No member runs yet → 0%.
    assert.equal(rollUpPipelineProgress(prid), 0);

    // Stage ru-a completes (terminal) → counts as a full stage: 1/4 = 25%.
    const aRun = createRun('ru-a', 'pipeline', 1, prid);
    finishRun(aRun, 'success', { exitCode: 0 });
    assert.equal(rollUpPipelineProgress(prid), 25);

    // Stage ru-b starts and reports 50% — setProgress rolls it up in real time:
    // (1 + 0.5) / 4 = 37.5% → 38 (no explicit rollUp call needed).
    const bRun = createRun('ru-b', 'pipeline', 1, prid);
    createRun('ru-c', 'pipeline', 1, prid); // ru-c running at 0% contributes nothing
    setProgress(bRun, 50, 'halfway');
    assert.equal(getPipelineRun(prid)?.progress, 38, 'mid-stage member progress rolled up live');

    // ru-b finishes its work (100%) → (1 + 1) / 4 = 50%; ru-d never started (0).
    setProgress(bRun, 100, 'done');
    assert.equal(getPipelineRun(prid)?.progress, 50);
    assert.equal(rollUpPipelineProgress(prid), 50);
  });

  await test('a failed upstream skips its dependent → status partial, dependent recorded skipped', async () => {
    const def: PipelineDefinition = { name: 'pp-partial', jobs: [{ job: 'fail-pp-a' }, { job: 'pp-dep', dependsOn: ['fail-pp-a'] }] };
    syncPipeline(def);
    const { pipelineRunId } = await runPipeline(def, 'manual');
    assert.equal(getPipelineRun(pipelineRunId!)?.status, 'partial');
    const memberRuns = listRunsForPipelineRun(pipelineRunId!);
    assert.ok(memberRuns.some((r) => r.job_name === 'fail-pp-a' && r.status === 'failed'));
    const skipped = memberRuns.find((r) => r.job_name === 'pp-dep');
    assert.equal(skipped?.status, 'skipped'); // never spawned — recorded by the skip cascade
  });

  await test('repeatUntilStable: cycles repeat while retryable work remains (up to maxCycles)', async () => {
    // Seed a permanently-retryable work item (failed, attempts < minAttempts) so the
    // pipeline never reaches "stable" and runs the full maxCycles.
    markWorkItem('rus-a', 'seed-key', 'failed', { attempts: 1 });
    const def: PipelineDefinition = {
      name: 'pp-repeat', jobs: [{ job: 'rus-a' }], repeatUntilStable: true, maxCycles: 2, cycleSleepMs: 0,
    };
    syncPipeline(def);
    const { pipelineRunId } = await runPipeline(def, 'manual');
    const logText = getPipelineLogs(pipelineRunId!).map((l) => l.message).join('\n');
    assert.ok(/cycle 1\/2/.test(logText), 'cycle 1 ran');
    assert.ok(/cycle 2\/2/.test(logText), 'cycle 2 ran (retryable work kept it going)');
    assert.ok(/retryable work left = 1/.test(logText), 'reported the outstanding retryable work');
    // member ran once per cycle
    assert.equal(listRunsForPipelineRun(pipelineRunId!).filter((r) => r.job_name === 'rus-a').length, 2);
  });

  await test('invalid DAG (cycle) → no members run, run finished failed with an error log', async () => {
    const def: PipelineDefinition = {
      name: 'pp-cyclic',
      jobs: [{ job: 'pp-a', dependsOn: ['pp-b'] }, { job: 'pp-b', dependsOn: ['pp-a'] }],
    };
    syncPipeline(def);
    const { pipelineRunId } = await runPipeline(def, 'manual');
    assert.ok(pipelineRunId);
    assert.equal(getPipelineRun(pipelineRunId!)?.status, 'failed');
    assert.equal(listRunsForPipelineRun(pipelineRunId!).length, 0); // never got to running members
    const logText = getPipelineLogs(pipelineRunId!).map((l) => l.message).join('\n');
    assert.ok(/Invalid pipeline DAG/.test(logText), `logs were: ${logText}`);
  });

  await test('validation gate: a satisfied contract lets the consumer run → success', async () => {
    const def: PipelineDefinition = {
      name: 'gate-pass', jobs: [{ job: 'g-prod' }, { job: 'g-cons-ok', dependsOn: ['g-prod'] }],
    };
    syncPipeline(def);
    const { pipelineRunId } = await runPipeline(def, 'manual');
    assert.equal(getPipelineRun(pipelineRunId!)?.status, 'success');
    const runs = listRunsForPipelineRun(pipelineRunId!);
    assert.ok(runs.every((r) => r.status === 'success'), 'both stages ran and succeeded');
    const logText = getPipelineLogs(pipelineRunId!).map((l) => l.message).join('\n');
    assert.ok(/1 gate\(s\)/.test(logText), 'gate count surfaced in the start log');
    assert.ok(/gate ok \[g-prod → g-cons-ok\] artifact "csv"/.test(logText), `gate-ok not logged: ${logText}`);
  });

  await test('validation gate: a CONSUMER-side drift fails the gate → consumer never runs, status partial', async () => {
    const def: PipelineDefinition = {
      name: 'gate-fail-consumer', jobs: [{ job: 'g-prod' }, { job: 'g-cons-bad', dependsOn: ['g-prod'] }],
    };
    syncPipeline(def);
    const { pipelineRunId } = await runPipeline(def, 'manual');
    assert.equal(getPipelineRun(pipelineRunId!)?.status, 'partial');
    const runs = listRunsForPipelineRun(pipelineRunId!);
    assert.ok(runs.some((r) => r.job_name === 'g-prod' && r.status === 'success'), 'producer ran first');
    const cons = runs.find((r) => r.job_name === 'g-cons-bad');
    assert.equal(cons?.status, 'failed'); // first-class failed run — NOT skipped
    assert.match(cons!.error ?? '', /Gate violation/);
    assert.match(cons!.error ?? '', /row 3 has no place_id/); // exact drift surfaced
  });

  await test('validation gate: a PRODUCER-side drift fails the gate before the consumer runs', async () => {
    const def: PipelineDefinition = {
      name: 'gate-fail-producer', jobs: [{ job: 'g-prod-bad' }, { job: 'g-cons-ok', dependsOn: ['g-prod-bad'] }],
    };
    syncPipeline(def);
    const { pipelineRunId } = await runPipeline(def, 'manual');
    assert.equal(getPipelineRun(pipelineRunId!)?.status, 'partial');
    const cons = listRunsForPipelineRun(pipelineRunId!).find((r) => r.job_name === 'g-cons-ok');
    assert.equal(cons?.status, 'failed');
    assert.match(cons!.error ?? '', /missing column 'cid'/);
  });

  await test('validation gate: a contract that THROWS is treated as a violation, not a crash', async () => {
    const def: PipelineDefinition = {
      name: 'gate-fail-throw', jobs: [{ job: 'g-prod' }, { job: 'g-cons-throw', dependsOn: ['g-prod'] }],
    };
    syncPipeline(def);
    const { pipelineRunId } = await runPipeline(def, 'manual');
    assert.equal(getPipelineRun(pipelineRunId!)?.status, 'partial');
    const cons = listRunsForPipelineRun(pipelineRunId!).find((r) => r.job_name === 'g-cons-throw');
    assert.equal(cons?.status, 'failed');
    assert.match(cons!.error ?? '', /check threw — page structure changed/);
  });

  await test('validation gate: a gate failure CASCADES — the consumer\'s own dependents are skipped', async () => {
    const def: PipelineDefinition = {
      name: 'gate-cascade',
      jobs: [
        { job: 'g-prod' },
        { job: 'g-cons-bad', dependsOn: ['g-prod'] },
        { job: 'pp-dep', dependsOn: ['g-cons-bad'] },
      ],
    };
    syncPipeline(def);
    const { pipelineRunId } = await runPipeline(def, 'manual');
    const runs = listRunsForPipelineRun(pipelineRunId!);
    assert.equal(runs.find((r) => r.job_name === 'g-cons-bad')?.status, 'failed');
    assert.equal(runs.find((r) => r.job_name === 'pp-dep')?.status, 'skipped'); // downstream of the gated stage
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

console.log(`\n${passed} pipeline-executor test(s) passed.`);
