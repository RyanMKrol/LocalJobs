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
  getPipelineLogs, getPipelineRun, listRunsForPipelineRun, markWorkItem, syncJob, syncPipeline,
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
const members = ['pp-a', 'pp-b', 'fail-pp-a', 'pp-dep', 'rus-a'];
const pushed: JobDefinition[] = [];
for (const name of members) {
  const d: JobDefinition = { name, run: async () => {} };
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
    const memberRuns = listRunsForPipelineRun(pipelineRunId!);
    assert.equal(memberRuns.length, 2);
    assert.ok(memberRuns.every((r) => r.status === 'success'));
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
