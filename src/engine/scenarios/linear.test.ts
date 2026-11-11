// SCENARIO: a linear pipeline, run for real with fixture stages.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { config } from '../../config.js';
import { getLogs } from '../../db/store.js';
import { setupScenario } from '../testing/scenario.js';
import { cancelWorkflowRun } from '../workflow-executor.js';
import { jobs, linearWorkflow, mirrorWorkflow } from './linear.scenario.js';

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

const s = setupScenario({ moduleUrl: new URL('./linear.scenario.ts', import.meta.url).href, jobs, workflows: [linearWorkflow, mirrorWorkflow] });

try {
  await test('data flows down the chain; every stage records its inputs and outputs; the host is notified once', async () => {
    const before = s.notifications.length;
    const r = await s.run(linearWorkflow);
    assert.equal(r.status, 'success', r.log);
    assert.deepEqual(r.statuses, { 'ln-fetch': 'success', 'ln-transform': 'success', 'ln-publish': 'success' });
    assert.equal(readFileSync(s.path('report.md'), 'utf8'), '# Report\n\nSum: 12\n');
    assert.deepEqual(r.inputsOf('ln-transform'), ['fetched<-ln-fetch']);
    assert.deepEqual(r.inputsOf('ln-publish'), ['transformed<-ln-transform']);
    // The transform stage's output lives in a folder nothing had created: the engine made it.
    assert.deepEqual(s.readJson<{ doubled: number[] }>('made-on-first-write/out/transformed.json').doubled, [2, 4, 6]);
    assert.equal(r.artifact('ln-fetch', 'fetched')?.summary_json?.includes('3 row(s)'), true);
    assert.equal(r.artifact('ln-publish', 'report')?.storage, 'file', 'a file the stage wrote itself was committed by the sweep');
    assert.equal(JSON.parse(r.artifact('ln-publish', 'total')!.inline_json!), 12);
    assert.deepEqual(s.notifications.slice(before), [{ workflow: 'ln-linear', workflowRunId: r.id, status: 'success' }]);
    // The stage was told which run and attempt it is.
    const fetchLog = getLogs(r.stage('ln-fetch')!.id).map((l) => l.message).join('\n');
    assert.match(fetchLog, new RegExp(`run ${r.id}, attempt 1`));
  });

  await test('an output that fails its check stops the pipeline at the SOURCE: nothing downstream runs', async () => {
    s.control({ 'ln-fetch': 'empty' });
    const r = await s.run(linearWorkflow);
    assert.equal(r.status, 'failed', 'no stage succeeded');
    assert.equal(r.stage('ln-fetch')?.status, 'failed');
    assert.match(r.stage('ln-fetch')?.error ?? '', /output "fetched" \(ln-fetched\) of "ln-fetch" failed its check, nothing was written: has at least one row: 0 row\(s\)/);
    assert.equal(r.stage('ln-transform')?.outcome_reason, 'upstream-skipped');
    assert.equal(r.stage('ln-publish')?.outcome_reason, 'upstream-skipped');
    assert.deepEqual(s.readJson<{ rows: number[] }>('fetched.json').rows, [1, 2, 3], 'the previous good file was not overwritten with a bad one');
  });

  await test('a failure mid-chain is retried, then skips what follows; the next run recovers', async () => {
    s.control({ 'ln-transform': 'fail' });
    const r = await s.run(linearWorkflow);
    assert.equal(r.status, 'partial');
    assert.deepEqual(r.attempts('ln-transform').map((a) => [a.attempt, a.status]), [[1, 'failed'], [2, 'failed']], 'maxRetries: 1 → two attempts');
    assert.equal(r.stage('ln-publish')?.status, 'skipped');
    assert.match(r.stage('ln-publish')?.error ?? '', /upstream ln-transform did not succeed \(failed\)/);

    s.control({});
    const ok = await s.run(linearWorkflow);
    assert.equal(ok.status, 'success', ok.log);
  });

  await test('an injected fault makes a real stage misbehave for exactly the attempts asked for (faults.ts)', async () => {
    // The stage returns without running, so its declared output is not written: the
    // failure the engine reports is its own, not something the fixture staged.
    const faults = s.path('engine-faults.json');
    process.env.LOCALJOBS_FAULTS_FILE = faults;
    try {
      writeFileSync(faults, JSON.stringify([{ job: 'ln-fetch', fault: 'skip-outputs' }]));
      const r = await s.run(linearWorkflow);
      assert.equal(r.stage('ln-fetch')?.status, 'failed');
      assert.match(r.stage('ln-fetch')?.error ?? '', /finished without writing its declared output "fetched"/);
      assert.equal(r.stage('ln-transform')?.outcome_reason, 'upstream-skipped');
      assert.match(getLogs(r.stage('ln-fetch')!.id).map((l) => l.message).join('\n'), /INJECTED FAULT "skip-outputs"/);
      assert.equal(existsSync(faults), false, 'the fault was used up and the file removed');

      const ok = await s.run(linearWorkflow);
      assert.equal(ok.status, 'success', 'the next run is unaffected');
    } finally {
      delete process.env.LOCALJOBS_FAULTS_FILE;
    }
  });

  await test('resume: a new run reuses the stages that succeeded and runs only the rest', async () => {
    s.control({ 'ln-transform': 'fail' });
    const failed = await s.run(linearWorkflow);
    assert.equal(failed.stage('ln-fetch')?.status, 'success');
    assert.equal(failed.stage('ln-transform')?.status, 'failed');

    s.control({});
    const r = await s.run(linearWorkflow, { resumeFrom: failed.id });
    assert.equal(r.status, 'success', r.log);
    // The fetch stage was NOT run again: one settled row, no child process, the reason says why.
    const fetch = r.stage('ln-fetch')!;
    assert.equal(fetch.outcome_reason, 'resumed');
    assert.equal(getLogs(fetch.id).length, 0, 'a reused stage has no log of its own: it never ran');
    assert.match(r.log, /↺ ln-fetch not run: reused from run/);
    assert.match(r.log, /▶ ln-transform runs again: it did not succeed in that run \(failed\)/);
    assert.match(r.log, /▶ ln-publish runs again: it did not succeed in that run \(skipped, upstream-skipped\)/);
    // Its artifact is re-recorded under this run, marked as carried over, and is what transform was handed.
    const carried = r.artifact('ln-fetch', 'fetched')!;
    assert.equal(carried.fresh, 0);
    assert.match(carried.note ?? '', /reused from run/);
    assert.equal(carried.sha256, failed.artifact('ln-fetch', 'fetched')!.sha256);
    assert.deepEqual(r.inputsOf('ln-transform'), ['fetched<-ln-fetch']);
    assert.equal(r.stage('ln-transform')?.status, 'success');
    assert.equal(r.stage('ln-publish')?.status, 'success');
  });

  await test('resume: a stage whose output has changed since is not reused, and neither is anything after it', async () => {
    // Make the LAST stage fail (an injected fault, for every attempt it gets).
    const faults = s.path('engine-faults.json');
    process.env.LOCALJOBS_FAULTS_FILE = faults;
    writeFileSync(faults, JSON.stringify([{ job: 'ln-publish', fault: 'fail', attempts: 10 }]));
    const failed = await s.run(linearWorkflow);
    rmSync(faults, { force: true });
    delete process.env.LOCALJOBS_FAULTS_FILE;
    assert.equal(failed.stage('ln-transform')?.status, 'success');
    assert.equal(failed.stage('ln-publish')?.status, 'failed');

    // Something rewrites the first stage's file after the run.
    writeFileSync(s.path('fetched.json'), JSON.stringify({ rows: [9, 9, 9] }));
    const r = await s.run(linearWorkflow, { resumeFrom: failed.id });
    assert.equal(r.status, 'success', r.log);
    assert.match(r.log, /▶ ln-fetch runs again: its "fetched" output cannot be reused: .*has changed since that run/);
    assert.match(r.log, /▶ ln-transform runs again: "ln-fetch", which it depends on, is being run again/);
    assert.notEqual(r.stage('ln-fetch')?.outcome_reason, 'resumed');
    assert.deepEqual(s.readJson<{ rows: number[] }>('fetched.json').rows, [1, 2, 3], 'the stage ran and wrote its own output again');
  });

  await test('cancelling mid-run kills the running stage and records the rest as not started; a later run is unaffected', async () => {
    s.control({ 'ln-transform': 'hang' });
    const { id, done } = await s.start(linearWorkflow);
    await s.until(id, 'the hanging stage to be running', (rep) => rep.stage('ln-transform')?.status === 'running');
    cancelWorkflowRun(id, 'cancelled by the scenario');
    await done;
    const r = s.report(id);
    assert.equal(r.status, 'cancelled');
    assert.equal(r.run.end_reason, 'cancelled by the scenario');
    assert.equal(r.stage('ln-fetch')?.status, 'success');
    assert.equal(r.stage('ln-transform')?.status, 'cancelled');
    assert.equal(r.stage('ln-publish')?.outcome_reason, 'not-started-cancelled');

    s.control({});
    assert.equal((await s.run(linearWorkflow)).status, 'success');
  });

  await test('a workflow that comes `after` another starts at once when that one is idle', async () => {
    const r = await s.run(mirrorWorkflow);
    assert.equal(r.status, 'success', r.log);
    assert.doesNotMatch(r.log, /Waiting for/);
  });

  await test('a workflow that comes `after` another waits while that one is running, then runs', async () => {
    s.control({ 'ln-transform': 'hang' });
    const pipeline = await s.start(linearWorkflow);
    await s.until(pipeline.id, 'the pipeline to be mid-run', (rep) => rep.stage('ln-transform')?.status === 'running');

    const mirror = await s.start(mirrorWorkflow);
    const waiting = await s.until(mirror.id, 'the mirror to say it is waiting', (rep) => /Waiting for ln-linear to finish/.test(rep.log));
    // Give it several polls' worth of time: it must still not have started a stage.
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(s.report(mirror.id).status, 'running');
    assert.deepEqual(s.report(mirror.id).runs, [], 'no stage of the waiting run has started');
    assert.doesNotMatch(waiting.log, /Workflow "ln-mirror-wf" started/);

    // The pipeline ends (how it ends does not matter: the wait is only for it to be over).
    cancelWorkflowRun(pipeline.id, 'cancelled by the scenario');
    await pipeline.done;
    const r = await mirror.done;
    assert.equal(r.status, 'success', r.log);
    assert.match(r.log, /ln-linear has finished\./);
    assert.match(r.log, /Waited \d+s\. Starting now\./);
    assert.equal(r.stage('ln-mirror')?.status, 'success');
    s.control({});
  });

  await test('a wait that goes on too long gives up with a warning and starts anyway', async () => {
    s.control({ 'ln-transform': 'hang' });
    const pipeline = await s.start(linearWorkflow);
    await s.until(pipeline.id, 'the pipeline to be mid-run', (rep) => rep.stage('ln-transform')?.status === 'running');
    const maxWait = config.afterMaxWaitMs;
    config.afterMaxWaitMs = 100;
    try {
      const r = await s.run(mirrorWorkflow);
      assert.equal(r.status, 'success', r.log);
      assert.match(r.log, /Still running after .*: ln-linear\. Starting anyway/);
    } finally {
      config.afterMaxWaitMs = maxWait;
      cancelWorkflowRun(pipeline.id, 'cancelled by the scenario');
      await pipeline.done;
      s.control({});
    }
  });

  await test('a run that is waiting can be cancelled: its stages are recorded as never started', async () => {
    s.control({ 'ln-transform': 'hang' });
    const pipeline = await s.start(linearWorkflow);
    await s.until(pipeline.id, 'the pipeline to be mid-run', (rep) => rep.stage('ln-transform')?.status === 'running');
    const mirror = await s.start(mirrorWorkflow);
    await s.until(mirror.id, 'the mirror to say it is waiting', (rep) => /Waiting for ln-linear/.test(rep.log));

    cancelWorkflowRun(mirror.id, 'no longer needed');
    const r = await mirror.done;
    assert.equal(r.status, 'cancelled');
    assert.equal(r.run.end_reason, 'no longer needed');
    assert.equal(r.stage('ln-mirror')?.outcome_reason, 'not-started-cancelled');

    cancelWorkflowRun(pipeline.id, 'cancelled by the scenario');
    await pipeline.done;
    s.control({});
  });
} finally {
  s.cleanup();
}

console.log(`\n${passed} linear scenario test(s) passed.`);
