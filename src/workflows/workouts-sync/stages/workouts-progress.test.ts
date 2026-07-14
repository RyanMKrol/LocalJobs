// workouts-progress tests — hermetic: no live Claude CLI calls, no filesystem
// outside a scratch tmp dir, injected fake runClaude + fixed workout history.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { isWorkItemDone } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import type { HevyWorkout } from './hevy-sync.js';
import {
  baselinePeriod,
  currentPeriod,
  computeExerciseComparisons,
  estimatedOneRepMax,
  runWorkoutsProgress,
} from './workouts-progress.js';

function fakeCtx(): JobContext {
  return {
    log() {},
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

// "Now" = 2026-07-15 -> current period = June 2026, baseline period = December 2025.
const NOW = new Date('2026-07-15T12:00:00Z');

function makeWorkout(
  id: string,
  startTime: string,
  exercises: { templateId: string; title: string; sets: { weight_kg: number | null; reps: number | null }[] }[],
): HevyWorkout {
  return {
    id,
    title: `Workout ${id}`,
    description: '',
    start_time: startTime,
    end_time: startTime,
    updated_at: startTime,
    created_at: startTime,
    exercises: exercises.map((e, i) => ({
      index: i,
      title: e.title,
      notes: '',
      exercise_template_id: e.templateId,
      superset_id: null,
      sets: e.sets.map((s, si) => ({
        index: si,
        set_type: 'normal',
        weight_kg: s.weight_kg,
        reps: s.reps,
        distance_meters: null,
        duration_seconds: null,
        rpe: null,
      })),
    })),
  };
}

describe('workouts-progress — period math', () => {
  it('current period is the most recently completed calendar month', () => {
    const p = currentPeriod(NOW);
    assert.equal(p.key, '2026-06');
  });

  it('baseline period is exactly 6 months before the current period', () => {
    const p = baselinePeriod(NOW);
    assert.equal(p.key, '2025-12');
  });
});

describe('workouts-progress — computeExerciseComparisons', () => {
  const baseline = baselinePeriod(NOW);
  const current = currentPeriod(NOW);

  it('computes best set, total volume, and estimated 1RM correctly for both periods', () => {
    const workouts: HevyWorkout[] = [
      // Baseline (Dec 2025): squat 100kg x5, 90kg x8
      makeWorkout('w1', '2025-12-05T08:00:00Z', [
        {
          templateId: 'squat',
          title: 'Squat',
          sets: [
            { weight_kg: 100, reps: 5 },
            { weight_kg: 90, reps: 8 },
          ],
        },
      ]),
      // Current (Jun 2026): squat 120kg x3, 110kg x5
      makeWorkout('w2', '2026-06-10T08:00:00Z', [
        {
          templateId: 'squat',
          title: 'Squat',
          sets: [
            { weight_kg: 120, reps: 3 },
            { weight_kg: 110, reps: 5 },
          ],
        },
      ]),
      // Second exercise, baseline only
      makeWorkout('w3', '2025-12-06T08:00:00Z', [
        { templateId: 'bench', title: 'Bench Press', sets: [{ weight_kg: 60, reps: 10 }] },
      ]),
      // Second exercise, current only
      makeWorkout('w4', '2026-06-12T08:00:00Z', [
        { templateId: 'bench', title: 'Bench Press', sets: [{ weight_kg: 70, reps: 6 }] },
      ]),
      // Outside both periods — must be ignored entirely
      makeWorkout('w5', '2026-03-01T08:00:00Z', [
        { templateId: 'squat', title: 'Squat', sets: [{ weight_kg: 999, reps: 99 }] },
      ]),
    ];

    const comparisons = computeExerciseComparisons(workouts, baseline, current);
    const squat = comparisons.find((c) => c.exerciseTemplateId === 'squat')!;
    const bench = comparisons.find((c) => c.exerciseTemplateId === 'bench')!;

    assert.ok(squat, 'squat comparison present');
    assert.ok(bench, 'bench comparison present');

    // Squat baseline: best = 100x5 (highest weight); volume = 100*5 + 90*8 = 1220
    assert.equal(squat.baseline!.bestSetWeightKg, 100);
    assert.equal(squat.baseline!.bestSetReps, 5);
    assert.equal(squat.baseline!.totalVolumeKg, 100 * 5 + 90 * 8);
    assert.equal(
      squat.baseline!.estOneRepMaxKg,
      Math.max(estimatedOneRepMax(100, 5), estimatedOneRepMax(90, 8)),
    );

    // Squat current: best = 120x3; volume = 120*3 + 110*5 = 910
    assert.equal(squat.current!.bestSetWeightKg, 120);
    assert.equal(squat.current!.bestSetReps, 3);
    assert.equal(squat.current!.totalVolumeKg, 120 * 3 + 110 * 5);
    assert.equal(
      squat.current!.estOneRepMaxKg,
      Math.max(estimatedOneRepMax(120, 3), estimatedOneRepMax(110, 5)),
    );

    // Bench: baseline only 60x10, current only 70x6
    assert.equal(bench.baseline!.bestSetWeightKg, 60);
    assert.equal(bench.baseline!.totalVolumeKg, 600);
    assert.equal(bench.current!.bestSetWeightKg, 70);
    assert.equal(bench.current!.totalVolumeKg, 420);

    // The 999x99 set in March must not leak into either period.
    assert.equal(squat.baseline!.bestSetWeightKg < 999, true);
    assert.equal(squat.current!.bestSetWeightKg < 999, true);
  });

  it('excludes an exercise whose sets are all null-weight (duration-based) without crashing', () => {
    const workouts: HevyWorkout[] = [
      makeWorkout('w1', '2026-06-10T08:00:00Z', [
        { templateId: 'plank', title: 'Plank', sets: [{ weight_kg: null, reps: null }] },
      ]),
    ];
    const comparisons = computeExerciseComparisons(workouts, baseline, current);
    assert.equal(comparisons.length, 0, 'duration-only exercise excluded entirely');
  });

  it('records skippedNullSets count when an exercise mixes usable and null sets', () => {
    const workouts: HevyWorkout[] = [
      makeWorkout('w1', '2026-06-10T08:00:00Z', [
        {
          templateId: 'row',
          title: 'Row',
          sets: [
            { weight_kg: 50, reps: 10 },
            { weight_kg: null, reps: null },
          ],
        },
      ]),
    ];
    const comparisons = computeExerciseComparisons(workouts, baseline, current);
    const row = comparisons.find((c) => c.exerciseTemplateId === 'row')!;
    assert.ok(row);
    assert.equal(row.skippedNullSets, 1);
    assert.equal(row.current!.setCount, 1);
  });
});

describe('runWorkoutsProgress — end-to-end with injected Claude', () => {
  let scratchDir: string;
  let historyPath: string;
  let outDir: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'workouts-progress-'));
    historyPath = join(scratchDir, 'workouts-history.json');
    outDir = join(scratchDir, 'out');
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  function seedHistory() {
    const workouts: HevyWorkout[] = [
      makeWorkout('w1', '2025-12-05T08:00:00Z', [
        { templateId: 'squat', title: 'Squat', sets: [{ weight_kg: 100, reps: 5 }] },
      ]),
      makeWorkout('w2', '2026-06-10T08:00:00Z', [
        { templateId: 'squat', title: 'Squat', sets: [{ weight_kg: 120, reps: 3 }] },
      ]),
    ];
    writeFileSync(historyPath, JSON.stringify(workouts, null, 2));
  }

  it('writes progress-data.json and workouts-progress.md, and marks the ledger for the current month', async () => {
    seedHistory();
    let promptSeen = '';
    await runWorkoutsProgress(fakeCtx(), {
      historyPath,
      outDir,
      now: NOW,
      runClaudeFn: async (prompt) => {
        promptSeen = prompt;
        return { ok: true, text: '# Progress report\n\nSquat improved.', rateLimited: false };
      },
    });

    assert.ok(existsSync(join(outDir, 'progress-data.json')));
    assert.ok(existsSync(join(outDir, 'workouts-progress.md')));
    const md = readFileSync(join(outDir, 'workouts-progress.md'), 'utf8');
    assert.match(md, /Squat improved/);

    const data = JSON.parse(readFileSync(join(outDir, 'progress-data.json'), 'utf8'));
    assert.equal(data.currentPeriod, '2026-06');
    assert.equal(data.baselinePeriod, '2025-12');
    assert.ok(promptSeen.includes('squat'));

    assert.ok(isWorkItemDone('workouts-progress', '2026-06', 3));
  });

  it('re-running within the same month overwrites the report without duplicating the ledger row or filename', async () => {
    seedHistory();
    const runClaudeFn = async () => ({ ok: true, text: 'first run', rateLimited: false });
    await runWorkoutsProgress(fakeCtx(), { historyPath, outDir, now: NOW, runClaudeFn });

    const runClaudeFn2 = async () => ({ ok: true, text: 'second run', rateLimited: false });
    await runWorkoutsProgress(fakeCtx(), { historyPath, outDir, now: NOW, runClaudeFn: runClaudeFn2 });

    const md = readFileSync(join(outDir, 'workouts-progress.md'), 'utf8');
    assert.equal(md, 'second run', 'second run overwrote the same static filename, no duplicate file');
    assert.ok(isWorkItemDone('workouts-progress', '2026-06', 3));
  });

  it('does nothing gracefully when no history file exists yet', async () => {
    await runWorkoutsProgress(fakeCtx(), {
      historyPath: join(scratchDir, 'nope.json'),
      outDir,
      now: NOW,
      runClaudeFn: async () => ({ ok: true, text: 'unused', rateLimited: false }),
    });
    assert.ok(!existsSync(join(outDir, 'progress-data.json')));
  });

  it('throws when Claude fails', async () => {
    seedHistory();
    await assert.rejects(
      () =>
        runWorkoutsProgress(fakeCtx(), {
          historyPath,
          outDir,
          now: NOW,
          runClaudeFn: async () => ({ ok: false, text: '', rateLimited: false, error: 'boom' }),
        }),
      /boom/,
    );
  });

  it('soft-pauses without throwing when Claude is rate/usage-limited (T572) — no output written, no ledger mark', async () => {
    seedHistory();
    const rateLimitedNow = new Date('2026-08-15T12:00:00Z'); // distinct month key, unaffected by other tests in this suite
    const logs: Array<[string, string | undefined]> = [];
    const ctx = fakeCtx();
    ctx.log = (message, level) => { logs.push([message, level]); };

    await runWorkoutsProgress(ctx, {
      historyPath,
      outDir,
      now: rateLimitedNow,
      runClaudeFn: async () => ({ ok: false, text: '', rateLimited: true, error: 'usage limit reached' }),
    });

    assert.ok(!existsSync(join(outDir, 'workouts-progress.md')), 'no narrative report written on rate limit');
    assert.ok(
      !isWorkItemDone('workouts-progress', currentPeriod(rateLimitedNow).key, 3),
      'item left un-done so a later run resumes it',
    );
    const warnLog = logs.find(([message]) => message.includes('rate/usage limit'));
    assert.ok(warnLog, 'expected a rate-limit warn log line');
    assert.equal(warnLog![1], 'warn');
  });
});
