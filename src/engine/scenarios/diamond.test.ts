// SCENARIO: a diamond. Two sides run in parallel, a join with two different inputs waits for both.
import assert from 'node:assert/strict';
import { setupScenario } from '../testing/scenario.js';
import { diamondWorkflow, jobs } from './diamond.scenario.js';

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

const s = setupScenario({ moduleUrl: new URL('./diamond.scenario.ts', import.meta.url).href, jobs, workflows: [diamondWorkflow] });

try {
  await test('the two sides run in parallel, and the join starts only after BOTH have finished, with both inputs', async () => {
    const r = await s.run(diamondWorkflow);
    assert.equal(r.status, 'success', r.log);
    const l = s.readJson<{ value: number; at: [number, number] }>('dm-left.json');
    const rt = s.readJson<{ value: number; at: [number, number] }>('dm-right.json');
    const j = s.readJson<{ value: number; startedAt: number }>('joined.json');
    assert.equal(j.value, 5 + 40, 'the join read the left (4+1) and right (4*10) results');
    assert.ok(l.at[0] < rt.at[1] && rt.at[0] < l.at[1], 'the two sides overlapped in time');
    assert.ok(j.startedAt >= l.at[1] && j.startedAt >= rt.at[1], 'the join began after both sides finished');
    assert.deepEqual(r.inputsOf('dm-join'), ['left<-dm-left', 'right<-dm-right']);
  });

  await test('one side failing skips the join; the healthy side still ran and its output is kept', async () => {
    s.control({ 'dm-right': 'fail' });
    const r = await s.run(diamondWorkflow);
    assert.equal(r.status, 'partial');
    assert.deepEqual(r.statuses, { 'dm-source': 'success', 'dm-left': 'success', 'dm-right': 'failed', 'dm-join': 'skipped' });
    assert.match(r.stage('dm-join')?.error ?? '', /upstream dm-right did not succeed \(failed\)/);
    assert.ok(r.artifact('dm-left', 'out'), 'the healthy side committed its output');
    assert.deepEqual(r.inputsOf('dm-join'), [], 'the join was never even resolved');
  });
} finally {
  s.cleanup();
}

console.log(`\n${passed} diamond scenario test(s) passed.`);
