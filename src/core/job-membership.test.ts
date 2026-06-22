// Unit tests for `orphanJobNames` — the load-time guard that enforces the
// "every job must belong to a workflow" invariant (there are NO standalone jobs).
// A non-empty result is a configuration error that makes the registry fail loud.
// Pure function, so we test it directly with synthetic job/workflow shapes rather
// than importing the live (filesystem-discovered) registry.
import assert from 'node:assert/strict';
import { orphanJobNames } from '../jobs/registry.js';

let passed = 0;
function ok(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`); process.exitCode = 1; }
}

ok('a job that is a workflow member is NOT an orphan', () => {
  const jobs = [{ name: 'a' }, { name: 'b' }];
  const workflows = [{ jobs: [{ job: 'a' }, { job: 'b' }] }];
  assert.deepEqual(orphanJobNames(jobs, workflows), []);
});

ok('a single job in its own one-stage workflow is NOT an orphan', () => {
  const jobs = [{ name: 'solo' }];
  const workflows = [{ jobs: [{ job: 'solo' }] }];
  assert.deepEqual(orphanJobNames(jobs, workflows), []);
});

ok('a job in NO workflow is reported as an orphan', () => {
  const jobs = [{ name: 'a' }, { name: 'lonely' }];
  const workflows = [{ jobs: [{ job: 'a' }] }];
  assert.deepEqual(orphanJobNames(jobs, workflows), ['lonely']);
});

ok('with zero workflows, every job is an orphan', () => {
  const jobs = [{ name: 'a' }, { name: 'b' }];
  assert.deepEqual(orphanJobNames(jobs, []), ['a', 'b']);
});

ok('a job claimed by more than one workflow is still not an orphan', () => {
  const jobs = [{ name: 'shared' }];
  const workflows = [{ jobs: [{ job: 'shared' }] }, { jobs: [{ job: 'shared' }] }];
  assert.deepEqual(orphanJobNames(jobs, workflows), []);
});

console.log(`\n${passed} job-membership test(s) passed.`);
