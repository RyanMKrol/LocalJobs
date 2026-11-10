// Ports, end to end: a fan-out / fan-in workflow whose stages REALLY run, each in
// its own child process, through the production child runtime. These are the
// guarantees the ports model exists to give.
//
//   1. Inputs are passed in: each stage reads what its producer committed.
//   2. A fan-in receives every branch, and waits for all of them.
//   3. A stage that "succeeds" without writing its output FAILS, even with a stale
//      file from an earlier run sitting at the path. The next stage never runs.
//   4. An output that fails its check is never written, and fails the stage.
//   5. Only the producer's final successful attempt feeds a consumer.
//   6. A file changed between two stages by something else is caught.
//   7. A cumulative store with nothing new is carried forward, visibly.
//   8. Everything a stage read and wrote is recorded for the run.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { jobs, notifications } from './testing/fixture-host.js';
import {
  artifactsForRun, artifactsForWorkflowRun, getWorkflowLogs, getWorkflowRun, listRunsForWorkflowRun,
  producedArtifact, resolvedInputsForStage, syncJob, syncWorkflow,
} from '../db/store.js';
import { bindWorkflowPorts } from './ports.js';
import { resolveInput, uncommittedOutputs } from './resolve-inputs.js';
import { assertDaemonSupportsPorts } from './stage-runtime.js';
import { fanInWorkflow, fixtureJobs, storeWorkflow, type MergedData } from './testing/ports-fixtures.js';
import { runWorkflow } from './workflow-executor.js';
import type { RunRow } from './types.js';

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

const dir = mkdtempSync(join(tmpdir(), 'lj-ports-'));
const orig = { script: config.runJobScript, topic: config.ntfyTopic };
config.runJobScript = fileURLToPath(new URL('./testing/fixture-runner.ts', import.meta.url));
config.ntfyTopic = '';
// The fixture children must open THIS process's scratch DB and find the fixture dir.
process.env.LOCALJOBS_DB = config.dbPath;
process.env.LJ_FIXTURE_DIR = dir;

for (const d of fixtureJobs) {
  syncJob(d);
  jobs.push(d);
}
syncWorkflow(fanInWorkflow);
syncWorkflow(storeWorkflow);

const control = (c: Record<string, string>) => writeFileSync(join(dir, 'control.json'), JSON.stringify(c));
const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
const latest = (runs: RunRow[], job: string) => runs.filter((r) => r.job_name === job).at(-1);
const logText = (id: string) => getWorkflowLogs(id).map((l) => l.message).join('\n');

try {
  let firstRun = '';

  await test('inputs are passed in, the fan-in receives every branch, and what each stage read and wrote is recorded', async () => {
    control({});
    const { workflowRunId } = await runWorkflow(fanInWorkflow, 'manual');
    firstRun = workflowRunId!;
    const runs = listRunsForWorkflowRun(firstRun);
    assert.equal(getWorkflowRun(firstRun)?.status, 'success', logText(firstRun));

    // The merge got the source AND all three branches, each carrying this run's data.
    const merged = readJson<MergedData>('merged.json');
    assert.equal(merged.run, firstRun, "the source's data flowed through to the merge");
    assert.deepEqual(Object.keys(merged.parts).sort(), ['px-b1', 'px-b2', 'px-b3']);
    assert.deepEqual(merged.parts['px-b2'], ['A-px-b2', 'B-px-b2', 'C-px-b2']);

    // Recorded inputs of the merge: one per producer, each resolved to a committed artifact.
    const inputs = resolvedInputsForStage(firstRun, 'px-merge', 1);
    assert.deepEqual(inputs.map((i) => `${i.port}<-${i.producer_job}`).sort(), ['data<-px-src', 'parts<-px-b1', 'parts<-px-b2', 'parts<-px-b3']);
    assert.ok(inputs.every((i) => i.ok === 1 && i.artifact && i.artifact.workflow_run_id === firstRun));
    // …and the subset the merge said it actually used.
    const used = JSON.parse(inputs.find((i) => i.port === 'data')!.used_json!) as { total: number; items: { id: string }[] };
    assert.deepEqual(used.items.map((i) => i.id), ['a', 'b']);

    // Recorded outputs: every stage committed every port it declares.
    const artifacts = artifactsForWorkflowRun(firstRun);
    assert.deepEqual(artifacts.map((a) => `${a.job_name}.${a.port}`).sort(), [
      'px-b1.part', 'px-b2.part', 'px-b3.part', 'px-merge.merged', 'px-report.digest', 'px-src.data',
    ]);
    assert.ok(artifacts.every((a) => a.ok === 1 && a.fresh === 1));
    const src = artifacts.find((a) => a.job_name === 'px-src')!;
    assert.equal(src.item_count, 3);
    assert.match(src.sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.match(src.summary_json ?? '', /3 item\(s\) from run/);
    const dg = artifacts.find((a) => a.job_name === 'px-report')!;
    assert.deepEqual(JSON.parse(dg.inline_json!), { branches: 3, items: 9 }, 'an inline output is kept in the run record');
    for (const job of fixtureJobs.filter((j) => fanInWorkflow.jobs.some((r) => r.job === j.name))) {
      assert.deepEqual(uncommittedOutputs(latest(runs, job.name)!.id, job), [], `${job.name} committed everything`);
    }
    assert.match(logText(firstRun), /✓ input "parts" of px-merge ← px-b2 · artifact "px-part"/);
  });

  await test('a stage that returns success WITHOUT writing its output fails, despite a stale file from the last run; the fan-in never runs', async () => {
    // px-b2.json from the previous run is still on disk. That is the trap.
    assert.equal(readJson<{ from: string }>('px-b2.json').from, firstRun);
    control({ 'px-b2': 'skip-write' });
    const { workflowRunId } = await runWorkflow(fanInWorkflow, 'manual');
    const runs = listRunsForWorkflowRun(workflowRunId!);

    const b2 = latest(runs, 'px-b2')!;
    assert.equal(b2.status, 'failed', 'succeeding without producing anything is a failure');
    assert.match(b2.error ?? '', /finished without writing its declared output "part" \(px-part\) this run/);
    assert.match(b2.error ?? '', /was last written before this stage started/);

    assert.equal(latest(runs, 'px-b1')!.status, 'success', 'the healthy branches still ran');
    assert.equal(latest(runs, 'px-b3')!.status, 'success');
    const merge = latest(runs, 'px-merge')!;
    assert.equal(merge.status, 'skipped');
    assert.equal(merge.outcome_reason, 'upstream-skipped');
    assert.match(merge.error ?? '', /px-b2 did not succeed \(failed\)/);
    assert.equal(latest(runs, 'px-report')!.status, 'skipped');
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'partial');
    assert.equal(readJson<MergedData>('merged.json').run, firstRun, 'the merge did not run: its old output is untouched');
  });

  await test('an output that fails its check is never written, and fails the stage', async () => {
    const before = readFileSync(join(dir, 'px-b1.json'), 'utf8');
    control({ 'px-b1': 'bad-output' });
    const { workflowRunId } = await runWorkflow(fanInWorkflow, 'manual');
    const b1 = latest(listRunsForWorkflowRun(workflowRunId!), 'px-b1')!;
    assert.equal(b1.status, 'failed');
    assert.match(b1.error ?? '', /output "part" \(px-part\) of "px-b1" failed its check, nothing was written: has an upper array: missing/);
    assert.equal(readFileSync(join(dir, 'px-b1.json'), 'utf8'), before, 'the bad value never reached disk');
    const rec = artifactsForRun(b1.id);
    assert.equal(rec.length, 1);
    assert.equal(rec[0].ok, 0, 'the failed check is recorded, so the run page can show why');
  });

  await test("only the producer's final successful attempt feeds a consumer (an earlier attempt that wrote, then failed, is ignored)", async () => {
    control({ 'px-b3': 'write-then-fail-once' });
    const { workflowRunId } = await runWorkflow(fanInWorkflow, 'manual');
    const id = workflowRunId!;
    const runs = listRunsForWorkflowRun(id);
    assert.equal(getWorkflowRun(id)?.status, 'success', logText(id));
    const attempts = runs.filter((r) => r.job_name === 'px-b3');
    assert.deepEqual(attempts.map((r) => [r.attempt, r.status]), [[1, 'failed'], [2, 'success']]);
    assert.equal(artifactsForRun(attempts[0].id).length, 1, 'attempt 1 did commit something before failing');

    const resolved = producedArtifact(id, 1, 'px-b3', 'px-part')!;
    assert.equal(resolved.run_id, attempts[1].id, "resolution picks the successful attempt's artifact");
    assert.deepEqual(readJson<MergedData>('merged.json').parts['px-b3'], ['A-px-b3', 'B-px-b3', 'C-px-b3']);
  });

  await test('a stage that writes its file itself and never calls commit() is committed by the end-of-run sweep', async () => {
    control({ 'px-b1': 'raw-write' });
    const { workflowRunId } = await runWorkflow(fanInWorkflow, 'manual');
    assert.equal(getWorkflowRun(workflowRunId!)?.status, 'success', logText(workflowRunId!));
    const b1 = latest(listRunsForWorkflowRun(workflowRunId!), 'px-b1')!;
    const rec = artifactsForRun(b1.id);
    assert.equal(rec.length, 1);
    assert.equal(rec[0].ok, 1);
    assert.equal(rec[0].item_count, 3);
  });

  await test('a file changed by something else after its producer committed it does not resolve', async () => {
    control({});
    const { workflowRunId } = await runWorkflow(fanInWorkflow, 'manual');
    const id = workflowRunId!;
    const binding = bindWorkflowPorts(fanInWorkflow, (n) => fixtureJobs.find((j) => j.name === n)).bindings
      .find((b) => b.consumer === 'px-merge' && b.producer === 'px-b1')!;
    assert.equal(resolveInput(id, 1, binding).ok, true, 'untouched: resolves');

    // Rewriting identical bytes is not a change (only the content decides)…
    const path = join(dir, 'px-b1.json');
    const same = readFileSync(path, 'utf8');
    writeFileSync(path, same);
    assert.equal(resolveInput(id, 1, binding).ok, true);
    // …different bytes are.
    writeFileSync(path, same.replace('A-px-b1', 'TAMPERED'));
    const r = resolveInput(id, 1, binding);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /has changed since "px-b1" committed it/);
    rmSync(path);
    assert.match(resolveInput(id, 1, binding).reason ?? '', /no longer exists/);
  });

  await test('a cumulative store with nothing new is carried forward and marked as such; a first run with no store at all fails', async () => {
    control({ 'px-store': 'nothing-new' });
    const empty = await runWorkflow(storeWorkflow, 'manual');
    const failed = latest(listRunsForWorkflowRun(empty.workflowRunId!), 'px-store')!;
    assert.equal(failed.status, 'failed', 'carrying forward a store that does not exist is not possible');
    assert.match(failed.error ?? '', /store\.json does not exist/);

    control({});
    const first = await runWorkflow(storeWorkflow, 'manual');
    assert.equal(getWorkflowRun(first.workflowRunId!)?.status, 'success', logText(first.workflowRunId!));
    assert.equal(artifactsForWorkflowRun(first.workflowRunId!).find((a) => a.port === 'store')!.fresh, 1);

    control({ 'px-store': 'nothing-new' });
    const second = await runWorkflow(storeWorkflow, 'manual');
    const id = second.workflowRunId!;
    assert.equal(getWorkflowRun(id)?.status, 'success', logText(id));
    const store = artifactsForWorkflowRun(id).find((a) => a.port === 'store')!;
    assert.equal(store.fresh, 0, 'recorded for THIS run, but as carried forward');
    assert.equal(store.note, 'nothing new to add this run');
    assert.deepEqual(JSON.parse(artifactsForWorkflowRun(id).find((a) => a.port === 'count')!.inline_json!), 1, 'the reader still got the store');
    assert.match(logText(id), /carried forward unchanged/);
  });

  await test('a ports stage refuses to run under a daemon too old to resolve its inputs', async () => {
    assert.throws(() => assertDaemonSupportsPorts('some-stage', { LOCALJOBS_ENGINE: '2' }), /Restart it \(scripts\/safe-restart\.sh\)/);
    assert.throws(() => assertDaemonSupportsPorts('some-stage', {}), /the daemon is running older code/);
    assert.doesNotThrow(() => assertDaemonSupportsPorts('some-stage', { LOCALJOBS_ENGINE: '3' }));
  });
} finally {
  config.runJobScript = orig.script;
  config.ntfyTopic = orig.topic;
  for (const d of fixtureJobs) {
    const i = jobs.indexOf(d);
    if (i >= 0) jobs.splice(i, 1);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} ports end-to-end test(s) passed.`);
