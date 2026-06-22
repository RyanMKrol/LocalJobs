// Unit tests for `orphanJobNames` — the load-time guard that enforces the
// "every job must belong to a pipeline" invariant (there are NO standalone jobs).
// A non-empty result is a configuration error that makes the registry fail loud.
// Pure function, so we test it directly with synthetic job/pipeline shapes rather
// than importing the live (filesystem-discovered) registry.
import assert from 'node:assert/strict';
import { orphanJobNames } from '../jobs/registry.js';

let passed = 0;
function ok(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`); process.exitCode = 1; }
}

ok('a job that is a pipeline member is NOT an orphan', () => {
  const jobs = [{ name: 'a' }, { name: 'b' }];
  const pipelines = [{ jobs: [{ job: 'a' }, { job: 'b' }] }];
  assert.deepEqual(orphanJobNames(jobs, pipelines), []);
});

ok('a single job in its own one-stage pipeline is NOT an orphan', () => {
  const jobs = [{ name: 'solo' }];
  const pipelines = [{ jobs: [{ job: 'solo' }] }];
  assert.deepEqual(orphanJobNames(jobs, pipelines), []);
});

ok('a job in NO pipeline is reported as an orphan', () => {
  const jobs = [{ name: 'a' }, { name: 'lonely' }];
  const pipelines = [{ jobs: [{ job: 'a' }] }];
  assert.deepEqual(orphanJobNames(jobs, pipelines), ['lonely']);
});

ok('with zero pipelines, every job is an orphan', () => {
  const jobs = [{ name: 'a' }, { name: 'b' }];
  assert.deepEqual(orphanJobNames(jobs, []), ['a', 'b']);
});

ok('a job claimed by more than one pipeline is still not an orphan', () => {
  const jobs = [{ name: 'shared' }];
  const pipelines = [{ jobs: [{ job: 'shared' }] }, { jobs: [{ job: 'shared' }] }];
  assert.deepEqual(orphanJobNames(jobs, pipelines), []);
});

console.log(`\n${passed} job-membership test(s) passed.`);
