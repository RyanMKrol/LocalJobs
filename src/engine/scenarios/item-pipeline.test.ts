// SCENARIO: an incremental item pipeline, run for real with fixture stages.
// Discover → process each item once → publish each processed item once.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { db } from '../../db/index.js';
import { getWorkItem } from '../../db/store.js';
import { stageIo } from '../reporting.js';
import { setupScenario } from '../testing/scenario.js';
import { jobs, pipelineWorkflow } from './item-pipeline.scenario.js';
import type { WorkflowDefinition } from '../types.js';

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

const cycling: WorkflowDefinition = { ...pipelineWorkflow, name: 'ip-pipeline-cycling', repeatUntilStable: true, maxCycles: 4, minAttempts: 3 };
const s = setupScenario({ moduleUrl: new URL('./item-pipeline.scenario.ts', import.meta.url).href, jobs, workflows: [pipelineWorkflow, cycling] });
const source = (ids: string[]) => writeFileSync(s.path('source.json'), JSON.stringify(ids));
const published = () => (existsSync(s.path('published')) ? readdirSync(s.path('published')).sort() : []);
const attempts = (job: string, key: string) => getWorkItem(job, key)?.attempts;
/** Ledger rows this run CHANGED for a job, as `key:status`. */
const changed = (runId: string, job: string) =>
  (db.prepare("SELECT item_key, status FROM work_item_runs WHERE workflow_run_id = ? AND job_name = ? AND changed = 1 ORDER BY item_key").all(runId, job) as { item_key: string; status: string }[])
    .map((r) => `${r.item_key}:${r.status}`);

try {
  await test('first run: every discovered item flows through both stages', async () => {
    source(['alpha', 'beta']);
    const r = await s.run(pipelineWorkflow);
    assert.equal(r.status, 'success', r.log);
    assert.deepEqual(published(), ['alpha.md', 'beta.md']);
    assert.deepEqual(changed(r.id, 'ip-process'), ['alpha:success', 'beta:success']);
    assert.equal(r.artifact('ip-discover', 'discovered')?.storage, 'ledger');
    assert.equal(r.artifact('ip-discover', 'discovered')?.item_count, 2);
    assert.equal(r.artifact('ip-process', 'processed')?.item_count, 2);
    assert.equal(r.artifact('ip-process', 'processed')?.fresh, 1);
  });

  await test('a second run with nothing new does nothing, says so, and carries its stores forward', async () => {
    const r = await s.run(pipelineWorkflow);
    assert.equal(r.status, 'skipped', 'a run in which no stage changed anything is a noop');
    for (const stage of ['ip-discover', 'ip-process', 'ip-publish']) {
      assert.equal(r.stage(stage)?.status, 'skipped', `${stage} ran but had nothing to do`);
      assert.equal(r.stage(stage)?.outcome_reason, 'noop');
    }
    assert.deepEqual(changed(r.id, 'ip-process'), [], 'nothing was re-processed');
    assert.equal(r.artifact('ip-process', 'processed')?.fresh, 0, 'the store is recorded for this run, as carried forward');
    assert.equal(r.artifact('ip-discover', 'discovered')?.fresh, 0, 're-recording an unchanged catalogue is not new content');
    // Downstream still ran against the carried-forward stores (noop is not a failure).
    assert.deepEqual(r.inputsOf('ip-publish'), ['processed<-ip-process']);
  });

  await test('a new item is the only thing a later run touches, and the run page lists exactly that', async () => {
    source(['alpha', 'beta', 'gamma']);
    const r = await s.run(pipelineWorkflow);
    assert.equal(r.status, 'success', r.log);
    assert.deepEqual(changed(r.id, 'ip-discover'), ['gamma:success']);
    assert.deepEqual(changed(r.id, 'ip-process'), ['gamma:success']);
    assert.deepEqual(changed(r.id, 'ip-publish'), ['gamma:success']);
    assert.deepEqual(published(), ['alpha.md', 'beta.md', 'gamma.md']);

    // What the dashboard shows for the process stage in this run.
    const io = stageIo((n) => jobs.find((j) => j.name === n), r.run, pipelineWorkflow, 'ip-process', { limit: 100, inputsOffset: 0, outputsOffset: 0 })!;
    assert.equal(io.mode, 'ports');
    assert.deepEqual(io.inputs.items.map((i) => i.itemKey), ['gamma'], 'inputs: the one upstream item it worked on, not the whole catalogue');
    assert.deepEqual(io.outputs.items.map((i) => [i.title, i.fields]), [['gamma', [{ label: 'Length', value: '5' }]]], 'outputs: described by the stage itself');
    assert.equal(io.outputs.unchangedCount, 0);
    assert.deepEqual(io.inputs.artifacts.map((a) => `${a.consumerPort}<-${a.job}`), ['discovered<-ip-discover']);
  });

  await test('an item that fails: the others still complete, the stage fails, the next stage does not run, attempts are counted', async () => {
    source(['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
    s.control({ 'ip-process': 'fail:delta' });
    const r = await s.run(pipelineWorkflow);
    assert.equal(r.status, 'partial');
    assert.equal(r.stage('ip-process')?.status, 'failed');
    assert.match(r.stage('ip-process')?.error ?? '', /1\/2 item\(s\) failed this run/);
    assert.equal(r.stage('ip-publish')?.outcome_reason, 'upstream-skipped');
    assert.deepEqual(changed(r.id, 'ip-process'), ['delta:failed', 'epsilon:success'], 'one bad item did not stop the good one');
    assert.equal(attempts('ip-process', 'delta'), 1);
    assert.deepEqual(published(), ['alpha.md', 'beta.md', 'gamma.md'], 'nothing new was published this run');
  });

  await test('once the cause is fixed, the next run picks up exactly what is outstanding', async () => {
    s.control({});
    const r = await s.run(pipelineWorkflow);
    assert.equal(r.status, 'success', r.log);
    assert.deepEqual(changed(r.id, 'ip-process'), ['delta:success'], 'only the previously failed item is processed');
    assert.equal(attempts('ip-process', 'delta'), 2);
    assert.deepEqual(changed(r.id, 'ip-publish'), ['delta:success', 'epsilon:success'], 'publish catches up on both');
    assert.equal(published().length, 5);
  });

  await test('a limited run (limit 1) takes ONE originating input through every stage and leaves the rest alone', async () => {
    source(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta']);
    const r = await s.run(pipelineWorkflow, { limit: 1 });
    assert.equal(r.status, 'success', r.log);
    assert.equal(r.run.run_limit, 1);
    const selected = JSON.parse(r.run.selected_roots ?? '[]') as string[];
    assert.equal(selected.length, 1);
    for (const stage of ['ip-discover', 'ip-process', 'ip-publish']) {
      assert.deepEqual(changed(r.id, stage), [`${selected[0]}:success`], `${stage} handled only the selected input`);
    }
    const other = ['zeta', 'eta'].find((x) => x !== selected[0])!;
    assert.equal(getWorkItem('ip-discover', other), undefined, 'the unselected input was not even recorded');
    // An unlimited run then picks the rest up.
    const rest = await s.run(pipelineWorkflow);
    assert.deepEqual(changed(rest.id, 'ip-publish'), [`${other}:success`]);
  });

  await test('a stage that hits a quota before completing anything is STALLED, and the run is partial, not a green tick', async () => {
    source(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']);
    s.control({ 'ip-process': 'quota' });
    const r = await s.run(pipelineWorkflow);
    assert.equal(r.stage('ip-process')?.status, 'skipped');
    assert.equal(r.stage('ip-process')?.outcome_reason, 'stalled', 'it had work queued and completed none of it');
    assert.equal(r.status, 'partial');
    assert.match(r.log, /ip-process → STALLED/);
    assert.equal(getWorkItem('ip-process', 'theta')?.status, 'skipped');
    assert.equal(attempts('ip-process', 'theta'), 0, 'a soft stop is not an attempt');
    s.control({});
    assert.equal((await s.run(pipelineWorkflow)).status, 'success', 'the next run resumes');
  });

  await test('repeatUntilStable: a transient item failure is retried in the next cycle of the SAME run, then the run settles', async () => {
    source(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota']);
    s.control({ 'ip-process': 'fail-once:iota' });
    const r = await s.run(cycling);
    assert.equal(r.run.cycles, 2, r.log);
    assert.deepEqual(r.attempts('ip-process').map((a) => [a.cycle, a.status]), [[1, 'failed'], [2, 'success']]);
    assert.equal(attempts('ip-process', 'iota'), 2);
    assert.equal(r.status, 'success');
    assert.ok(published().includes('iota.md'), 'published in the second cycle');
    assert.match(r.log, /Stable — no retryable work remaining/);
    // Inputs are resolved per cycle: the second cycle's publish read the second cycle's store.
    assert.deepEqual(r.inputsOf('ip-publish', 2), ['processed<-ip-process']);
  });
} finally {
  s.cleanup();
}

console.log(`\n${passed} item-pipeline scenario test(s) passed.`);
