// SCENARIO: a linear pipeline, run for real with fixture stages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getLogs } from '../../db/store.js';
import { setupScenario } from '../testing/scenario.js';
import { cancelWorkflowRun } from '../workflow-executor.js';
import { jobs, linearWorkflow } from './linear.scenario.js';

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

const s = setupScenario({ moduleUrl: new URL('./linear.scenario.ts', import.meta.url).href, jobs, workflows: [linearWorkflow] });

try {
  await test('data flows down the chain; every stage records its inputs and outputs; the host is notified once', async () => {
    const before = s.notifications.length;
    const r = await s.run(linearWorkflow);
    assert.equal(r.status, 'success', r.log);
    assert.deepEqual(r.statuses, { 'ln-fetch': 'success', 'ln-transform': 'success', 'ln-publish': 'success' });
    assert.equal(readFileSync(s.path('report.md'), 'utf8'), '# Report\n\nSum: 12\n');
    assert.deepEqual(r.inputsOf('ln-transform'), ['fetched<-ln-fetch']);
    assert.deepEqual(r.inputsOf('ln-publish'), ['transformed<-ln-transform']);
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
} finally {
  s.cleanup();
}

console.log(`\n${passed} linear scenario test(s) passed.`);
