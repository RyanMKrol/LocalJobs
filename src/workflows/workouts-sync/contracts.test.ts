// The workouts-sync artifact checks, and that the two stages bind as the manifest says.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindWorkflowPorts, validateWorkflowContracts } from '../../engine/ports.js';
import type { JobDefinition } from '../../engine/index.js';
import { workoutsHistory } from './contracts.js';
import type { HevyWorkout } from './stages/hevy-sync.js';
import hevySync from './stages/hevy-sync.job.js';
import progress from './stages/workouts-progress.job.js';
import workflow from './workouts-sync.workflow.js';

const okWorkout = {
  id: 'w1', title: 'Push day', description: '', start_time: '2026-01-01T10:00:00Z', end_time: '2026-01-01T11:00:00Z',
  updated_at: '2026-01-01T11:00:00Z', created_at: '2026-01-01T10:00:00Z', exercises: [],
} as HevyWorkout;

test('workouts-history: a well-formed array passes, and so does an empty one (a fresh install)', () => {
  const r = workoutsHistory.check([okWorkout]);
  assert.equal(r.ok, true, r.violations?.join('; '));
  assert.equal(workoutsHistory.check([]).ok, true);
  assert.equal(workoutsHistory.summary!([okWorkout]), '1 workout(s)');
});

test('workouts-history: a non-array value fails, and so does an entry with no id', () => {
  assert.equal(workoutsHistory.check({ workouts: [okWorkout] } as unknown as HevyWorkout[]).ok, false);
  assert.equal(workoutsHistory.check([{ ...okWorkout, id: undefined } as unknown as HevyWorkout]).ok, false);
});

test('the progress stage is handed the history by the sync stage', () => {
  const jobs = new Map<string, JobDefinition>([hevySync, progress].map((j) => [j.name, j]));
  const getJob = (name: string) => jobs.get(name);
  assert.deepEqual(validateWorkflowContracts(workflow, getJob), []);
  assert.deepEqual(
    bindWorkflowPorts(workflow, getJob).bindings.map((b) => `${b.producer} -> ${b.consumer}.${b.port}`),
    ['hevy-sync -> workouts-progress.history'],
  );
});
