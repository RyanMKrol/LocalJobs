// Dependency-free self-running tests: `npx tsx src/core/dag.test.ts`
import assert from 'node:assert/strict';
import { buildDag, classifyGates, DagError, deriveGates, executeDag, gateFailurePrefix } from './dag.js';
import type { Gate, GateRunRef } from './dag.js';
import type { WorkflowJobRef } from './types.js';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

test('linear chain → one job per wave, in order', () => {
  const refs: WorkflowJobRef[] = [
    { job: 'a' },
    { job: 'b', dependsOn: ['a'] },
    { job: 'c', dependsOn: ['b'] },
  ];
  const dag = buildDag(refs);
  assert.deepEqual(dag.waves, [['a'], ['b'], ['c']]);
});

test('diamond → parallel middle wave, join waits for both', () => {
  const refs: WorkflowJobRef[] = [
    { job: 'a' },
    { job: 'b', dependsOn: ['a'] },
    { job: 'c', dependsOn: ['a'] },
    { job: 'd', dependsOn: ['b', 'c'] },
  ];
  const dag = buildDag(refs);
  assert.deepEqual(dag.waves[0], ['a']);
  assert.deepEqual(dag.waves[1].sort(), ['b', 'c']);
  assert.deepEqual(dag.waves[2], ['d']);
});

test('cross-level dep lands one wave after its LATEST dependency', () => {
  // d depends on a (wave0) and c (wave2) → d must be wave3, not wave1.
  const refs: WorkflowJobRef[] = [
    { job: 'a' },
    { job: 'b', dependsOn: ['a'] },
    { job: 'c', dependsOn: ['b'] },
    { job: 'd', dependsOn: ['a', 'c'] },
  ];
  const dag = buildDag(refs);
  assert.deepEqual(dag.waves, [['a'], ['b'], ['c'], ['d']]);
});

test('independent roots share the first wave', () => {
  const dag = buildDag([{ job: 'x' }, { job: 'y' }, { job: 'z', dependsOn: ['x', 'y'] }]);
  assert.deepEqual(dag.waves[0].sort(), ['x', 'y']);
  assert.deepEqual(dag.waves[1], ['z']);
});

test('cycle is rejected', () => {
  assert.throws(
    () => buildDag([{ job: 'a', dependsOn: ['b'] }, { job: 'b', dependsOn: ['a'] }]),
    (e) => e instanceof DagError && /cycle/.test(e.message),
  );
});

test('self-edge is rejected', () => {
  assert.throws(() => buildDag([{ job: 'a', dependsOn: ['a'] }]), DagError);
});

test('dangling dependsOn (non-member) is rejected', () => {
  assert.throws(
    () => buildDag([{ job: 'a', dependsOn: ['ghost'] }]),
    (e) => e instanceof DagError && /not a member/.test(e.message),
  );
});

test('duplicate member is rejected', () => {
  assert.throws(() => buildDag([{ job: 'a' }, { job: 'a' }]), DagError);
});

test('dependents/dependencies maps are correct', () => {
  const dag = buildDag([{ job: 'a' }, { job: 'b', dependsOn: ['a'] }]);
  assert.deepEqual(dag.dependents.get('a'), ['b']);
  assert.deepEqual(dag.dependencies.get('b'), ['a']);
  assert.deepEqual(dag.dependencies.get('a'), []);
});

test('deriveGates: a key produced upstream and consumed downstream becomes one gate', () => {
  const dag = buildDag([{ job: 'a' }, { job: 'b', dependsOn: ['a'] }]);
  const gates = deriveGates(dag, new Map([['a', ['rows']], ['b', []]]), new Map([['a', []], ['b', ['rows']]]));
  assert.deepEqual(gates, [{ key: 'rows', producer: 'a', consumer: 'b' }]);
});

test('deriveGates: a consumed key with no producing upstream is NOT a gate (external input)', () => {
  const dag = buildDag([{ job: 'a' }, { job: 'b', dependsOn: ['a'] }]);
  // b consumes 'rows' but a produces nothing → no boundary to gate.
  const gates = deriveGates(dag, new Map([['a', []], ['b', []]]), new Map([['a', []], ['b', ['rows']]]));
  assert.deepEqual(gates, []);
});

test('deriveGates: only matching keys across an edge gate (mismatched keys ignored)', () => {
  const dag = buildDag([{ job: 'a' }, { job: 'b', dependsOn: ['a'] }]);
  const gates = deriveGates(dag, new Map([['a', ['rows', 'extra']], ['b', []]]), new Map([['a', []], ['b', ['rows', 'other']]]));
  assert.deepEqual(gates, [{ key: 'rows', producer: 'a', consumer: 'b' }]);
});

test('deriveGates: only DIRECT edges gate — a non-adjacent producer is skipped', () => {
  const dag = buildDag([{ job: 'a' }, { job: 'b', dependsOn: ['a'] }, { job: 'c', dependsOn: ['b'] }]);
  // a produces 'rows', c consumes 'rows', but a is not a direct dep of c → no gate.
  const gates = deriveGates(
    dag,
    new Map([['a', ['rows']], ['b', []], ['c', []]]),
    new Map([['a', []], ['b', []], ['c', ['rows']]]),
  );
  assert.deepEqual(gates, []);
});

test('deriveGates: a diamond join gates against BOTH producers of the same key', () => {
  const dag = buildDag([
    { job: 'a' }, { job: 'b', dependsOn: ['a'] }, { job: 'c', dependsOn: ['a'] }, { job: 'd', dependsOn: ['b', 'c'] },
  ]);
  const gates = deriveGates(
    dag,
    new Map([['a', []], ['b', ['k']], ['c', ['k']], ['d', []]]),
    new Map([['a', []], ['b', []], ['c', []], ['d', ['k']]]),
  );
  assert.deepEqual(gates.sort((x, y) => x.producer.localeCompare(y.producer)), [
    { key: 'k', producer: 'b', consumer: 'd' },
    { key: 'k', producer: 'c', consumer: 'd' },
  ]);
});

// ---- classifyGates: gate state from a run's member runs ----

const G: Gate = { key: 'rows', producer: 'a', consumer: 'b' };
const failRun = (id: string, gate: Gate, extra = 'csv layout drift'): GateRunRef => ({
  id, job_name: gate.consumer, status: 'failed', error: `${gateFailurePrefix(gate)}: ${extra}`,
});

test('classifyGates: a gate-failure run on the consumer → failed, links to that run', () => {
  const runs: GateRunRef[] = [
    { id: 'r1', job_name: 'a', status: 'success', error: null },
    failRun('r2', G),
  ];
  assert.deepEqual(classifyGates([G], runs), [{ ...G, state: 'failed', failureRunId: 'r2' }]);
});

test('classifyGates: consumer ran for real (not skipped, not a gate failure) → passed', () => {
  const runs: GateRunRef[] = [
    { id: 'r1', job_name: 'a', status: 'success', error: null },
    { id: 'r2', job_name: 'b', status: 'success', error: null },
  ];
  assert.deepEqual(classifyGates([G], runs), [{ ...G, state: 'passed' }]);
});

test('classifyGates: a real consumer failure (not a gate violation) still counts as gate passed', () => {
  // The gate let the consumer spawn; the consumer then failed on its own work.
  const runs: GateRunRef[] = [{ id: 'r2', job_name: 'b', status: 'failed', error: 'boom: timeout' }];
  assert.deepEqual(classifyGates([G], runs), [{ ...G, state: 'passed' }]);
});

test('classifyGates: consumer not yet run → pending', () => {
  const runs: GateRunRef[] = [{ id: 'r1', job_name: 'a', status: 'running', error: null }];
  assert.deepEqual(classifyGates([G], runs), [{ ...G, state: 'pending' }]);
});

test('classifyGates: consumer skipped by an upstream failure → pending (gate never evaluated)', () => {
  const runs: GateRunRef[] = [{ id: 'r2', job_name: 'b', status: 'skipped', error: 'skipped: upstream a did not succeed' }];
  assert.deepEqual(classifyGates([G], runs), [{ ...G, state: 'pending' }]);
});

test('classifyGates: one inbound gate failing leaves the consumer\'s OTHER inbound gate pending', () => {
  const g1: Gate = { key: 'rows', producer: 'a', consumer: 'c' };
  const g2: Gate = { key: 'meta', producer: 'b', consumer: 'c' };
  // Only g1 failed; the executor returns on first failure so g2 was never checked.
  const runs: GateRunRef[] = [failRun('r3', g1)];
  assert.deepEqual(classifyGates([g1, g2], runs), [
    { ...g1, state: 'failed', failureRunId: 'r3' },
    { ...g2, state: 'pending' },
  ]);
});

test('classifyGates: latest gate-failure run wins when a gate fails across cycles', () => {
  const runs: GateRunRef[] = [failRun('old', G), failRun('new', G)];
  assert.deepEqual(classifyGates([G], runs), [{ ...G, state: 'failed', failureRunId: 'new' }]);
});

test('classifyGates: a gate description (detail) is preserved into the classified status', () => {
  const described: Gate = { ...G, description: 'produces — CSV has rows · consumes — rows have place_id' };
  const runs: GateRunRef[] = [{ id: 'r2', job_name: 'b', status: 'success', error: null }];
  assert.deepEqual(classifyGates([described], runs), [{ ...described, state: 'passed' }]);
});

async function atest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

await atest('executeDag: linear chain runs in order, all success', async () => {
  const dag = buildDag([{ job: 'a' }, { job: 'b', dependsOn: ['a'] }, { job: 'c', dependsOn: ['b'] }]);
  const order: string[] = [];
  const res = await executeDag(dag, { runOne: async (j) => { order.push(j); return 'success'; } });
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(res.get('c'), 'success');
});

await atest('executeDag: a failed job skips its dependents (cascade), siblings still run', async () => {
  const dag = buildDag([
    { job: 'a' }, { job: 'b', dependsOn: ['a'] }, { job: 'c', dependsOn: ['b'] }, { job: 'd', dependsOn: ['a'] },
  ]);
  const ran: string[] = [];
  const res = await executeDag(dag, { runOne: async (j) => { ran.push(j); return j === 'b' ? 'failed' : 'success'; } });
  assert.equal(res.get('a'), 'success');
  assert.equal(res.get('b'), 'failed');
  assert.equal(res.get('c'), 'skipped'); // depends on the failed b
  assert.equal(res.get('d'), 'success'); // depends only on a
  assert.ok(!ran.includes('c')); // c never actually executed
});

await atest('executeDag: independent branches overlap up to concurrency', async () => {
  const dag = buildDag([
    { job: 'a' }, { job: 'b', dependsOn: ['a'] }, { job: 'c', dependsOn: ['a'] }, { job: 'd', dependsOn: ['b', 'c'] },
  ]);
  let active = 0;
  let maxActive = 0;
  const res = await executeDag(dag, {
    concurrency: 2,
    runOne: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 20)); active--; return 'success'; },
  });
  assert.equal(maxActive, 2); // b and c ran together
  assert.equal(res.get('d'), 'success');
});

await atest('executeDag: concurrency 1 is strictly serial', async () => {
  const dag = buildDag([{ job: 'a' }, { job: 'b', dependsOn: ['a'] }, { job: 'c', dependsOn: ['a'] }]);
  let active = 0;
  let maxActive = 0;
  await executeDag(dag, {
    concurrency: 1,
    runOne: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 10)); active--; return 'success'; },
  });
  assert.equal(maxActive, 1);
});

console.log(`\n${passed} dag test(s) passed.`);
