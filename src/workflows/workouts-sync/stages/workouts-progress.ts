import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { markWorkItem } from '../../../db/store.js';
import { runClaude, type ClaudeResult } from '../../../services/claude.js';
import type { JobContext } from '../../../core/types.js';
import { defaultHistoryPath, type HevyWorkout } from './hevy-sync.js';

const JOB_NAME = 'workouts-progress';
const CLAUDE_MODEL = process.env.WORKOUTS_PROGRESS_CLAUDE_MODEL ?? 'claude-sonnet-5';

const here = dirname(fileURLToPath(import.meta.url));
export const defaultOutDir = resolve(here, '../data/out');

// ---------------------------------------------------------------------------
// Calendar period helpers
// ---------------------------------------------------------------------------

export interface Period {
  /** "YYYY-MM" */
  key: string;
  /** Inclusive start of the calendar month (UTC). */
  start: Date;
  /** Exclusive end of the calendar month (UTC) — the first instant of the following month. */
  end: Date;
}

function monthKey(year: number, monthIndex0: number): string {
  return `${year}-${String(monthIndex0 + 1).padStart(2, '0')}`;
}

function periodFromMonthOffset(now: Date, monthsAgo: number): Period {
  // "Most recently completed calendar month" = the month before `now`'s month.
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
  const end = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1));
  return { key: monthKey(base.getUTCFullYear(), base.getUTCMonth()), start, end };
}

/** Current period = most recently completed calendar month relative to `now`. */
export function currentPeriod(now: Date): Period {
  return periodFromMonthOffset(now, 1);
}

/** Baseline period = the calendar month exactly 6 months before the current period. */
export function baselinePeriod(now: Date): Period {
  return periodFromMonthOffset(now, 7);
}

function inPeriod(isoDate: string, period: Period): boolean {
  const t = new Date(isoDate).getTime();
  return t >= period.start.getTime() && t < period.end.getTime();
}

// ---------------------------------------------------------------------------
// Per-exercise metric computation
// ---------------------------------------------------------------------------

export interface PeriodMetrics {
  bestSetWeightKg: number;
  bestSetReps: number;
  totalVolumeKg: number;
  estOneRepMaxKg: number;
  setCount: number;
}

export interface ExerciseComparison {
  exerciseTemplateId: string;
  title: string;
  skippedNullSets: number;
  baseline: PeriodMetrics | null;
  current: PeriodMetrics | null;
}

interface UsableSet {
  weightKg: number;
  reps: number;
}

/** Epley formula: 1RM ≈ weight * (1 + reps/30). */
export function estimatedOneRepMax(weightKg: number, reps: number): number {
  return weightKg * (1 + reps / 30);
}

function computePeriodMetrics(sets: UsableSet[]): PeriodMetrics | null {
  if (sets.length === 0) return null;
  let best = sets[0];
  let totalVolumeKg = 0;
  let estOneRepMaxKg = 0;
  for (const s of sets) {
    if (s.weightKg > best.weightKg || (s.weightKg === best.weightKg && s.reps > best.reps)) {
      best = s;
    }
    totalVolumeKg += s.weightKg * s.reps;
    estOneRepMaxKg = Math.max(estOneRepMaxKg, estimatedOneRepMax(s.weightKg, s.reps));
  }
  return {
    bestSetWeightKg: best.weightKg,
    bestSetReps: best.reps,
    totalVolumeKg,
    estOneRepMaxKg,
    setCount: sets.length,
  };
}

/**
 * Bucket every set from `workouts` into the baseline/current periods, group by
 * exercise, and compute the 3 metrics per period for every exercise that has
 * at least one qualifying set in either period.
 */
export function computeExerciseComparisons(
  workouts: HevyWorkout[],
  baseline: Period,
  current: Period,
): ExerciseComparison[] {
  interface Bucket {
    title: string;
    baselineSets: UsableSet[];
    currentSets: UsableSet[];
    skippedNullSets: number;
  }
  const byExercise = new Map<string, Bucket>();

  for (const workout of workouts) {
    const inBaseline = inPeriod(workout.start_time, baseline);
    const inCurrent = inPeriod(workout.start_time, current);
    if (!inBaseline && !inCurrent) continue;

    for (const exercise of workout.exercises) {
      let bucket = byExercise.get(exercise.exercise_template_id);
      if (!bucket) {
        bucket = { title: exercise.title, baselineSets: [], currentSets: [], skippedNullSets: 0 };
        byExercise.set(exercise.exercise_template_id, bucket);
      }
      for (const set of exercise.sets) {
        if (set.weight_kg == null || set.reps == null) {
          bucket.skippedNullSets++;
          continue;
        }
        const usable: UsableSet = { weightKg: set.weight_kg, reps: set.reps };
        if (inBaseline) bucket.baselineSets.push(usable);
        if (inCurrent) bucket.currentSets.push(usable);
      }
    }
  }

  const comparisons: ExerciseComparison[] = [];
  for (const [exerciseTemplateId, bucket] of byExercise) {
    const baselineMetrics = computePeriodMetrics(bucket.baselineSets);
    const currentMetrics = computePeriodMetrics(bucket.currentSets);
    if (!baselineMetrics && !currentMetrics) continue;
    comparisons.push({
      exerciseTemplateId,
      title: bucket.title,
      skippedNullSets: bucket.skippedNullSets,
      baseline: baselineMetrics,
      current: currentMetrics,
    });
  }
  return comparisons;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

export interface ProgressData {
  generatedAtIso: string;
  baselinePeriod: string;
  currentPeriod: string;
  exercises: ExerciseComparison[];
}

export function buildClaudePrompt(data: ProgressData): string {
  return (
    `Write a markdown report narrating a 6-month workout progress comparison.\n\n` +
    `Baseline period: ${data.baselinePeriod}\nCurrent period: ${data.currentPeriod}\n\n` +
    `For each exercise below, describe whether the lifter improved, plateaued, or declined ` +
    `across three metrics — best single set (weight x reps), total volume (sum of weight*reps), ` +
    `and estimated one-rep-max (Epley formula) — citing the actual baseline vs current numbers. ` +
    `If an exercise has no baseline or no current data, note that instead of comparing.\n\n` +
    `Data (JSON):\n${JSON.stringify(data, null, 2)}`
  );
}

export type RunClaude = (prompt: string, model: string) => Promise<ClaudeResult>;

export async function runWorkoutsProgress(
  ctx: JobContext,
  opts: {
    historyPath?: string;
    outDir?: string;
    now?: Date;
    runClaudeFn?: RunClaude;
  } = {},
): Promise<void> {
  const historyPath = opts.historyPath ?? defaultHistoryPath;
  const outDir = opts.outDir ?? defaultOutDir;
  const now = opts.now ?? new Date();
  const runClaudeFn = opts.runClaudeFn ?? runClaude;

  const current = currentPeriod(now);
  const baseline = baselinePeriod(now);

  ctx.log(
    `info: workouts-progress starting — baseline ${baseline.key}, current ${current.key}, history: ${historyPath}`,
  );

  if (!existsSync(historyPath)) {
    ctx.log(`info: no history file at ${historyPath} yet — nothing to compare`);
    ctx.progress(100, 'no history yet');
    return;
  }

  const raw = readFileSync(historyPath, 'utf8');
  const workouts: HevyWorkout[] = raw.trim() ? JSON.parse(raw) : [];
  ctx.log(`info: loaded ${workouts.length} workouts from history`);

  const exercises = computeExerciseComparisons(workouts, baseline, current);
  ctx.log(`info: computed comparisons for ${exercises.length} exercise(s)`);
  for (const ex of exercises) {
    const skipNote = ex.skippedNullSets > 0 ? ` (skipped ${ex.skippedNullSets} null-weight/reps set(s))` : '';
    ctx.log(
      `info: ${ex.title} (${ex.exerciseTemplateId})${skipNote} — ` +
        `baseline: ${ex.baseline ? `best ${ex.baseline.bestSetWeightKg}kg x${ex.baseline.bestSetReps}, vol ${ex.baseline.totalVolumeKg}, est1RM ${ex.baseline.estOneRepMaxKg.toFixed(1)}` : 'none'}; ` +
        `current: ${ex.current ? `best ${ex.current.bestSetWeightKg}kg x${ex.current.bestSetReps}, vol ${ex.current.totalVolumeKg}, est1RM ${ex.current.estOneRepMaxKg.toFixed(1)}` : 'none'}`,
    );
  }

  const data: ProgressData = {
    generatedAtIso: now.toISOString(),
    baselinePeriod: baseline.key,
    currentPeriod: current.key,
    exercises,
  };

  mkdirSync(outDir, { recursive: true });
  const dataPath = resolve(outDir, 'progress-data.json');
  writeFileSync(dataPath, JSON.stringify(data, null, 2));
  ctx.log(`info: wrote raw progress data to ${dataPath}`);

  ctx.progress(50, 'computed progress data — asking Claude for narrative');

  const prompt = buildClaudePrompt(data);
  const result = await runClaudeFn(prompt, CLAUDE_MODEL);
  if (result.rateLimited) {
    ctx.log('warn: Claude rate/usage limit hit — pausing this stage, will retry next run', 'warn');
    return;
  }
  if (!result.ok) {
    throw new Error(`Claude report generation failed: ${result.error ?? 'unknown error'}`);
  }

  const mdPath = resolve(outDir, 'workouts-progress.md');
  writeFileSync(mdPath, result.text, 'utf8');
  ctx.log(`info: wrote narrative report to ${mdPath}`);

  markWorkItem(JOB_NAME, current.key, 'success', {
    detail: { name: `Workouts progress — ${current.key}`, markdown: mdPath },
  });

  ctx.progress(100, `progress report for ${current.key} written`);
  ctx.log(
    `info: workouts-progress complete — ${exercises.length} exercise(s) compared for ${current.key} vs ${baseline.key}`,
  );
}
