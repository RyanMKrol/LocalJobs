import { callService } from '../../../core/services.js';
import { isWorkItemDone, markWorkItem, workItemCounts } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { dynamoPut } from '../../../services/dynamodb.service.js';

const JOB_NAME = 'hevy-sync';
const MAX_RETRIES = 3;
const PAGE_SIZE = 10;

const HEVY_API = 'https://api.hevyapp.com/v1';

// ---------------------------------------------------------------------------
// Types matching the Hevy API v1 response shapes
// ---------------------------------------------------------------------------

export interface HevySet {
  index: number;
  set_type: string;
  weight_kg: number | null;
  reps: number | null;
  distance_meters: number | null;
  duration_seconds: number | null;
  rpe: number | null;
}

export interface HevyExercise {
  index: number;
  title: string;
  notes: string;
  exercise_template_id: string;
  superset_id: number | null;
  sets: HevySet[];
}

export interface HevyWorkout {
  id: string;
  title: string;
  description: string;
  start_time: string;
  end_time: string;
  updated_at: string;
  created_at: string;
  exercises: HevyExercise[];
}

export interface HevyWorkoutsPage {
  page: number;
  page_count: number;
  workouts: HevyWorkout[];
}

// ---------------------------------------------------------------------------
// Injectable fetch (real implementation uses globalThis.fetch; tests inject a stub)
// ---------------------------------------------------------------------------

export type HevyFetcher = (page: number, pageSize: number) => Promise<HevyWorkoutsPage>;

export function makeHevyFetcher(apiKey: string): HevyFetcher {
  return async (page: number, pageSize: number) => {
    const url = `${HEVY_API}/workouts?page=${page}&pageSize=${pageSize}`;
    const res = await fetch(url, {
      headers: { 'api-key': apiKey },
    });
    if (!res.ok) {
      throw new Error(`Hevy API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<HevyWorkoutsPage>;
  };
}

// ---------------------------------------------------------------------------
// DynamoDB write helpers (injectable for testing)
// ---------------------------------------------------------------------------

export type DynamoPutter = (table: string, item: Record<string, unknown>) => Promise<void>;

export async function writeWorkoutToDynamo(
  workout: HevyWorkout,
  workoutsTable: string,
  exercisesTable: string,
  put: DynamoPutter,
): Promise<void> {
  // Write the workout row (exercises stored inline AND as separate rows for the
  // website's query patterns — mirrors the existing website backfill shape).
  const workoutItem: Record<string, unknown> = {
    id: workout.id,
    title: workout.title,
    description: workout.description,
    start_time: workout.start_time,
    end_time: workout.end_time,
    updated_at: workout.updated_at,
    created_at: workout.created_at,
    exercise_count: workout.exercises.length,
  };
  await put(workoutsTable, workoutItem);

  // Write each exercise as a separate row keyed by `{workoutId}_{index}`.
  for (const ex of workout.exercises) {
    const exerciseItem: Record<string, unknown> = {
      id: `${workout.id}_${ex.index}`,
      workout_id: workout.id,
      index: ex.index,
      title: ex.title,
      notes: ex.notes,
      exercise_template_id: ex.exercise_template_id,
      superset_id: ex.superset_id,
      sets: ex.sets,
      workout_start_time: workout.start_time,
    };
    await put(exercisesTable, exerciseItem);
  }
}

// ---------------------------------------------------------------------------
// Core sync logic (injectable dependencies for hermeticity in tests)
// ---------------------------------------------------------------------------

export async function runHevySync(
  ctx: JobContext,
  opts: {
    fetchPage?: HevyFetcher;
    putItem?: DynamoPutter;
    workoutsTable?: string;
    exercisesTable?: string;
  } = {},
): Promise<void> {
  const apiKey = process.env.HEVY_API_KEY ?? '';
  if (!apiKey) throw new Error('HEVY_API_KEY is not set');

  const workoutsTable = opts.workoutsTable ?? process.env.WORKOUTS_TABLE ?? 'Workouts';
  const exercisesTable = opts.exercisesTable ?? process.env.EXERCISES_TABLE ?? 'Exercises';

  const fetchPage = opts.fetchPage ?? makeHevyFetcher(apiKey);
  const putItem = opts.putItem ?? ((t, i) => callService('dynamodb', () => dynamoPut(t, i)));

  ctx.log(`info: workouts-sync starting — tables: ${workoutsTable} / ${exercisesTable}`);

  // Collect all workout ids across pages, newest first (Hevy default order).
  ctx.log('info: paginating Hevy API to discover workouts…');
  const allWorkouts: HevyWorkout[] = [];
  let page = 1;
  let pageCount = 1;

  // First page (needed to learn page_count).
  do {
    const data = await callService('hevy', () => fetchPage(page, PAGE_SIZE));
    pageCount = data.page_count;
    allWorkouts.push(...data.workouts);
    ctx.log(`info: fetched page ${page}/${pageCount} (${data.workouts.length} workouts)`);
    page++;
  } while (page <= pageCount);

  ctx.log(`info: discovered ${allWorkouts.length} total workouts from Hevy`);

  const counts = workItemCounts(JOB_NAME);
  const alreadySynced = counts['success'] ?? 0;
  ctx.log(
    `info: ledger: ${alreadySynced} already synced, ${counts['failed'] ?? 0} failed previously`,
  );

  const todo = allWorkouts.filter((w) => !isWorkItemDone(JOB_NAME, w.id, MAX_RETRIES));
  ctx.log(`info: ${todo.length} workouts to sync this run (${allWorkouts.length - todo.length} skipped — already done)`);

  if (todo.length === 0) {
    ctx.log('info: nothing new to sync — done');
    ctx.progress(100, 'all workouts already synced');
    return;
  }

  let done = 0;
  let failed = 0;

  for (const workout of todo) {
    ctx.log(`info: syncing workout ${workout.id} "${workout.title}" (${workout.exercises.length} exercises)`);
    try {
      await writeWorkoutToDynamo(workout, workoutsTable, exercisesTable, putItem);
      markWorkItem(JOB_NAME, workout.id, 'success');
      done++;
      ctx.log(`info: synced ${done}/${todo.length} — ${workout.id} "${workout.title}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`error: failed to sync workout ${workout.id}: ${msg}`);
      markWorkItem(JOB_NAME, workout.id, 'failed');
      failed++;
    }
    ctx.progress((done + failed) / todo.length * 100, `${done}/${todo.length} synced`);
  }

  ctx.log(
    `info: workouts-sync complete — synced ${done}, failed ${failed} out of ${todo.length} new workouts`,
  );

  if (failed > 0) {
    throw new Error(`${failed} workout(s) failed to sync — see logs above`);
  }
}
