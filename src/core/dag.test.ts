// Dependency-free self-running tests: `npx tsx src/core/dag.test.ts`
import assert from 'node:assert/strict';
import { buildDag, DagError, executeDag } from './dag.js';
import type { PipelineJobRef } from './types.js';

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
  const refs: PipelineJobRef[] = [
    { job: 'a' },
    { job: 'b', dependsOn: ['a'] },
    { job: 'c', dependsOn: ['b'] },
  ];
  const dag = buildDag(refs);
  assert.deepEqual(dag.waves, [['a'], ['b'], ['c']]);
});

test('diamond → parallel middle wave, join waits for both', () => {
  const refs: PipelineJobRef[] = [
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
  const refs: PipelineJobRef[] = [
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
