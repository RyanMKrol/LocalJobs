// hevy-sync tests — hermetic: no live Hevy API calls, no filesystem outside a scratch tmp dir.
// Uses a stub fetcher + a scratch history-file path + the scratch DB (npm test sets LOCALJOBS_DB).
// Covers: new workouts are recorded and marked done; already-synced workouts are skipped;
// the history file accumulates full workout data idempotently across runs.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { getWorkItem, isWorkItemDone, markWorkItem } from '../../../db/store.js';
import { callService } from '../../../core/services.js';
import type { JobContext } from '../../../core/types.js';
import {
  runHevySync,
  readWorkoutsHistory,
  type HevyWorkout,
  type HevyWorkoutsPage,
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

// NOTE: Job name must match the constant in hevy-sync.ts
const JOB = 'hevy-sync';

// Use unique workout ids per test to avoid ledger collisions when the scratch DB
// is shared across all tests in the process.
let idCounter = 0;
function uid(): string {
  return `test-workout-${Date.now()}-${++idCounter}`;
}

describe('runHevySync — local history accumulation', () => {
  let scratchDir: string;
  let historyPath: string;

  beforeEach(() => {
    process.env.HEVY_API_KEY = 'test-key';
    scratchDir = mkdtempSync(join(tmpdir(), 'workouts-history-'));
    historyPath = join(scratchDir, 'workouts-history.json');
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('skips a workout already marked success in the ledger', async () => {
    const id = uid();
    markWorkItem(JOB, id, 'success');

    await runHevySync(fakeCtx(), {
      fetchPage: singlePageFetcher([makeWorkout(id)]),
      historyPath,
    });

    assert.ok(!existsSync(historyPath), 'no history file written for an already-synced workout');
  });

  it('syncs a new workout, marks it done, and writes it to the history file', async () => {
    const id = uid();

    await runHevySync(fakeCtx(), {
      fetchPage: singlePageFetcher([makeWorkout(id, 2)]),
      historyPath,
    });

    assert.ok(isWorkItemDone(JOB, id, 3), 'ledger should mark the workout done');
    const history = readWorkoutsHistory(historyPath);
    assert.equal(history.length, 1);
    assert.equal(history[0].id, id);
    assert.equal(history[0].exercises.length, 2);

    const row = getWorkItem(JOB, id);
    assert.ok(row, 'expected a ledger row for the synced workout');
    const detail = row!.detail != null ? JSON.parse(row!.detail as unknown as string) : null;
    assert.equal(detail.name, `Workout ${id}`);
    assert.equal(detail.exerciseCount, 2);
    assert.equal(detail.setCount, 2);
  });

  it('running twice with the SAME data only appends each workout once (idempotent)', async () => {
    const id = uid();
    const fetchPage = singlePageFetcher([makeWorkout(id, 2)]);

    await runHevySync(fakeCtx(), { fetchPage, historyPath });
    await runHevySync(fakeCtx(), { fetchPage, historyPath });

    const history = readWorkoutsHistory(historyPath);
    assert.equal(history.length, 1, 'second run with identical data appends nothing new');
  });

  it('a second run with an extra new workout appends only that one new entry', async () => {
    const id1 = uid();
    const id2 = uid();

    await runHevySync(fakeCtx(), {
      fetchPage: singlePageFetcher([makeWorkout(id1)]),
      historyPath,
    });

    await runHevySync(fakeCtx(), {
      fetchPage: singlePageFetcher([makeWorkout(id1), makeWorkout(id2)]),
      historyPath,
    });

    const history = readWorkoutsHistory(historyPath);
    assert.equal(history.length, 2);
    const ids = history.map((w) => w.id);
    assert.ok(ids.includes(id1));
    assert.ok(ids.includes(id2));
  });

  it('handles multiple pages correctly', async () => {
    const ids = [uid(), uid(), uid()];
    const workouts = ids.map((id) => makeWorkout(id, 1));

    await runHevySync(fakeCtx(), {
      fetchPage: multiPageFetcher(workouts, 2),
      historyPath,
    });

    const history = readWorkoutsHistory(historyPath);
    assert.equal(history.length, 3);
    for (const id of ids) {
      assert.ok(isWorkItemDone(JOB, id, 3), `workout ${id} should be done`);
    }
  });

  it('no-ops gracefully when Hevy returns empty list', async () => {
    await runHevySync(fakeCtx(), {
      fetchPage: singlePageFetcher([]),
      historyPath,
    });
    assert.ok(!existsSync(historyPath));
  });

  it('throws if HEVY_API_KEY is missing', async () => {
    const saved = process.env.HEVY_API_KEY;
    delete process.env.HEVY_API_KEY;
    try {
      await assert.rejects(
        () =>
          runHevySync(fakeCtx(), {
            fetchPage: singlePageFetcher([]),
            historyPath,
          }),
        /HEVY_API_KEY/,
      );
    } finally {
      if (saved !== undefined) process.env.HEVY_API_KEY = saved;
    }
  });

  it('logs a per-workout failure at "error" level when recording it throws', async () => {
    // A workout with a null id forces markWorkItem's SQLite insert to violate its
    // NOT NULL constraint, exercising the per-workout catch block. The catch
    // block's own recovery markWorkItem call (marking it 'failed') hits the same
    // constraint and re-throws — that's expected here; what we're verifying is
    // that the error is logged at 'error' level before that happens.
    const badWorkout = makeWorkout(uid());
    (badWorkout as unknown as { id: string | null }).id = null;

    const logs: Array<[string, string | undefined]> = [];
    const ctx = fakeCtx();
    ctx.log = (message, level) => { logs.push([message, level]); };

    await assert.rejects(() =>
      runHevySync(ctx, {
        fetchPage: singlePageFetcher([badWorkout]),
        historyPath,
      }),
    );

    const errorLog = logs.find(([message]) => message.startsWith('error: failed to record workout'));
    assert.ok(errorLog, 'expected an error log line for the failed workout');
    assert.equal(errorLog![1], 'error');
  });

  it('reading a missing/empty history file returns an empty array', () => {
    assert.deepEqual(readWorkoutsHistory(join(scratchDir, 'nope.json')), []);
  });

  it('written history file is valid JSON with full workout shape preserved', async () => {
    const id = uid();
    await runHevySync(fakeCtx(), {
      fetchPage: singlePageFetcher([makeWorkout(id, 1)]),
      historyPath,
    });
    const raw = readFileSync(historyPath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed[0].exercises[0].sets[0].weight_kg, 60);
  });

  it('a repeated fetch of the same page within 22h is served from service_cache', async () => {
    // Verify that when callService is called twice with the same cacheKey
    // for the hevy service within the cache TTL (22 hours), the second call
    // returns the cached result without invoking the fetcher again.
    let callCount = 0;
    const fetchFn = async (): Promise<HevyWorkoutsPage> => {
      callCount++;
      return {
        page: 1,
        page_count: 1,
        workouts: [makeWorkout(uid())],
      };
    };

    // First call with a cacheKey — should call the fetcher
    callCount = 0;
    const result1 = await callService('hevy', fetchFn, {
      cacheKey: 'hevy:workouts:test-page-1',
    });
    assert.equal(callCount, 1, 'fetcher called once on first callService');
    const result1Id = result1.workouts[0].id;

    // Second call with the same cacheKey — should return cached result without calling fetcher
    callCount = 0;
    const result2 = await callService('hevy', fetchFn, {
      cacheKey: 'hevy:workouts:test-page-1',
    });
    assert.equal(callCount, 0, 'fetcher not called on second callService (cache hit)');
    assert.equal(result2.workouts[0].id, result1Id, 'cached result matches first result');
  });
});
