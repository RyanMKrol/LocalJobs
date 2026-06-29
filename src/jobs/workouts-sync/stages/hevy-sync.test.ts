// hevy-sync tests — hermetic: no live Hevy API calls, no live AWS writes.
// Uses a stub fetcher + stub putter + the scratch DB (npm test sets LOCALJOBS_DB).
// Covers: new workouts are synced and marked done; already-synced workouts are
// skipped; exercise rows are written per workout; failures are handled gracefully.
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import {
  runHevySync,
  writeWorkoutToDynamo,
  type HevyWorkout,
  type HevyWorkoutsPage,
  type DynamoPutter,
} from './hevy-sync.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeCtx(): JobContext {
  return {
    log() {},
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

function makeWorkout(id: string, exerciseCount = 1): HevyWorkout {
  return {
    id,
    title: `Workout ${id}`,
    description: '',
    start_time: '2026-01-01T08:00:00Z',
    end_time: '2026-01-01T09:00:00Z',
    updated_at: '2026-01-01T09:00:00Z',
    created_at: '2026-01-01T09:00:00Z',
    exercises: Array.from({ length: exerciseCount }, (_, i) => ({
      index: i,
      title: `Exercise ${i}`,
      notes: '',
      exercise_template_id: `tpl-${i}`,
      superset_id: null,
      sets: [
        { index: 0, set_type: 'normal', weight_kg: 60, reps: 8, distance_meters: null, duration_seconds: null, rpe: null },
      ],
    })),
  };
}

/** Single-page fetcher returning the given workouts. */
function singlePageFetcher(workouts: HevyWorkout[]) {
  return async (_page: number, _size: number): Promise<HevyWorkoutsPage> => ({
    page: 1,
    page_count: 1,
    workouts,
  });
}

/** Multi-page fetcher — splits workouts into pages of `pageSize`. */
function multiPageFetcher(workouts: HevyWorkout[], pageSize: number) {
  return async (page: number, _size: number): Promise<HevyWorkoutsPage> => {
    const start = (page - 1) * pageSize;
    const slice = workouts.slice(start, start + pageSize);
    return {
      page,
      page_count: Math.ceil(workouts.length / pageSize),
      workouts: slice,
    };
  };
}

/** Spy putter that records calls. Never throws. */
function makePutSpy() {
  const calls: { table: string; item: Record<string, unknown> }[] = [];
  const put: DynamoPutter = async (table, item) => {
    calls.push({ table, item });
  };
  return { put, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// NOTE: Job name must match the constant in hevy-sync.ts
const JOB = 'hevy-sync';

// Use unique workout ids per test to avoid ledger collisions when the scratch DB
// is shared across all tests in the process.
let idCounter = 0;
function uid(): string {
  return `test-workout-${Date.now()}-${++idCounter}`;
}

describe('writeWorkoutToDynamo', () => {
  it('writes one workout row and N exercise rows', async () => {
    const { put, calls } = makePutSpy();
    const w = makeWorkout('w1', 3);
    await writeWorkoutToDynamo(w, 'Workouts', 'Exercises', put);
    // 1 workout + 3 exercises
    assert.equal(calls.length, 4);
    assert.equal(calls[0].table, 'Workouts');
    assert.equal(calls[0].item['id'], 'w1');
    assert.equal(calls[1].table, 'Exercises');
    assert.equal(calls[1].item['workout_id'], 'w1');
    assert.equal(calls[1].item['id'], 'w1_0');
    assert.equal(calls[3].item['id'], 'w1_2');
  });

  it('writes workout with no exercises (exercise_count=0)', async () => {
    const { put, calls } = makePutSpy();
    const w = makeWorkout('w-noex', 0);
    await writeWorkoutToDynamo(w, 'Workouts', 'Exercises', put);
    assert.equal(calls.length, 1, 'only the workout row, no exercise rows');
    assert.equal(calls[0].item['exercise_count'], 0);
  });

  it('stores sets array on each exercise row', async () => {
    const { put, calls } = makePutSpy();
    const w = makeWorkout('w-sets', 1);
    await writeWorkoutToDynamo(w, 'W', 'E', put);
    const exRow = calls[1].item;
    assert.ok(Array.isArray(exRow['sets']), 'sets should be an array');
    assert.equal((exRow['sets'] as unknown[]).length, 1);
  });
});

describe('runHevySync — skip already-synced workouts', () => {
  beforeEach(() => {
    // Ensure HEVY_API_KEY is set so the guard doesn't throw.
    process.env.HEVY_API_KEY = 'test-key';
  });

  it('skips a workout already marked success in the ledger', async () => {
    const id = uid();
    markWorkItem(JOB, id, 'success');

    const { put, calls } = makePutSpy();
    await runHevySync(fakeCtx(), {
      fetchPage: singlePageFetcher([makeWorkout(id)]),
      putItem: put,
      workoutsTable: 'W',
      exercisesTable: 'E',
    });

    assert.equal(calls.length, 0, 'no DynamoDB writes for already-synced workout');
  });

  it('syncs a new workout and marks it done', async () => {
    const id = uid();
    const { put, calls } = makePutSpy();

    await runHevySync(fakeCtx(), {
      fetchPage: singlePageFetcher([makeWorkout(id, 2)]),
      putItem: put,
      workoutsTable: 'Workouts',
      exercisesTable: 'Exercises',
    });

    // 1 workout + 2 exercises = 3 puts
    assert.equal(calls.length, 3);
    assert.ok(isWorkItemDone(JOB, id, 3), 'ledger should mark the workout done');
  });

  it('syncs only NEW workouts when some already synced', async () => {
    const existingId = uid();
    const newId = uid();
    markWorkItem(JOB, existingId, 'success');

    const { put, calls } = makePutSpy();
    await runHevySync(fakeCtx(), {
      fetchPage: singlePageFetcher([makeWorkout(existingId), makeWorkout(newId)]),
      putItem: put,
      workoutsTable: 'W',
      exercisesTable: 'E',
    });

    // Only the new workout: 1 workout + 1 exercise = 2 puts
    assert.equal(calls.length, 2);
    const ids = calls.map((c) => c.item['id']);
    assert.ok(ids.includes(newId), 'new workout row written');
    assert.ok(!ids.includes(existingId), 'existing workout not re-written');
  });

  it('handles multiple pages correctly', async () => {
    const ids = [uid(), uid(), uid()];
    const workouts = ids.map((id) => makeWorkout(id, 1));

    const { put, calls } = makePutSpy();
    // pageSize=2 → 2 pages
    await runHevySync(fakeCtx(), {
      fetchPage: multiPageFetcher(workouts, 2),
      putItem: put,
      workoutsTable: 'W',
      exercisesTable: 'E',
    });

    // 3 workouts × (1 workout row + 1 exercise row) = 6 puts
    assert.equal(calls.length, 6);
    for (const id of ids) {
      assert.ok(isWorkItemDone(JOB, id, 3), `workout ${id} should be done`);
    }
  });

  it('marks workout failed in ledger when putter throws, then throws at end', async () => {
    const id = uid();

    const failingPut: DynamoPutter = async () => {
      throw new Error('DynamoDB unavailable');
    };

    await assert.rejects(
      () =>
        runHevySync(fakeCtx(), {
          fetchPage: singlePageFetcher([makeWorkout(id)]),
          putItem: failingPut,
          workoutsTable: 'W',
          exercisesTable: 'E',
        }),
      /failed to sync/,
    );

    // Ledger should record a failure (but not done).
    assert.ok(!isWorkItemDone(JOB, id, 3), 'failed workout should not be marked done');
  });

  it('no-ops gracefully when Hevy returns empty list', async () => {
    const { put, calls } = makePutSpy();
    await runHevySync(fakeCtx(), {
      fetchPage: singlePageFetcher([]),
      putItem: put,
      workoutsTable: 'W',
      exercisesTable: 'E',
    });
    assert.equal(calls.length, 0);
  });

  it('throws if HEVY_API_KEY is missing', async () => {
    const saved = process.env.HEVY_API_KEY;
    delete process.env.HEVY_API_KEY;
    try {
      await assert.rejects(
        () =>
          runHevySync(fakeCtx(), {
            fetchPage: singlePageFetcher([]),
            putItem: async () => {},
            workoutsTable: 'W',
            exercisesTable: 'E',
          }),
        /HEVY_API_KEY/,
      );
    } finally {
      if (saved !== undefined) process.env.HEVY_API_KEY = saved;
    }
  });
});
