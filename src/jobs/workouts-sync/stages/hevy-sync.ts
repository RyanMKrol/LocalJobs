import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { callService } from '../../../core/services.js';
import { isWorkItemDone, markWorkItem, workItemCounts } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';

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
// Local full-history JSON accumulator (replaces the former DynamoDB writes)
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
export const defaultHistoryPath = resolve(here, '../data/out/workouts-history.json');

/** Read the existing history file, or an empty array if it doesn't exist yet. */
export function readWorkoutsHistory(path: string): HevyWorkout[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return [];
  return JSON.parse(raw) as HevyWorkout[];
}

/** Append the given workouts (assumed new) to the history file and persist it. */
export function appendWorkoutsHistory(path: string, existing: HevyWorkout[], newWorkouts: HevyWorkout[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const merged = [...existing, ...newWorkouts];
  writeFileSync(path, JSON.stringify(merged, null, 2));
}

// ---------------------------------------------------------------------------
// Core sync logic (injectable dependencies for hermeticity in tests)
// ---------------------------------------------------------------------------

export async function runHevySync(
  ctx: JobContext,
  opts: {
    fetchPage?: HevyFetcher;
    historyPath?: string;
  } = {},
): Promise<void> {
  const apiKey = process.env.HEVY_API_KEY ?? '';
  if (!apiKey) throw new Error('HEVY_API_KEY is not set');

  const historyPath = opts.historyPath ?? defaultHistoryPath;

  const fetchPage = opts.fetchPage ?? makeHevyFetcher(apiKey);

  ctx.log(`info: workouts-sync starting — history file: ${historyPath}`);

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

  const existing = readWorkoutsHistory(historyPath);
  ctx.log(`info: loaded ${existing.length} previously-recorded workouts from ${historyPath}`);

  let done = 0;
  let failed = 0;
  const newlyAppended: HevyWorkout[] = [];

  for (const workout of todo) {
    ctx.log(`info: recording workout ${workout.id} "${workout.title}" (${workout.exercises.length} exercises)`);
    try {
      newlyAppended.push(workout);
      markWorkItem(JOB_NAME, workout.id, 'success');
      done++;
      ctx.log(`info: recorded ${done}/${todo.length} — ${workout.id} "${workout.title}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`error: failed to record workout ${workout.id}: ${msg}`);
      markWorkItem(JOB_NAME, workout.id, 'failed');
      failed++;
    }
    ctx.progress((done + failed) / todo.length * 100, `${done}/${todo.length} recorded`);
  }

  if (newlyAppended.length > 0) {
    appendWorkoutsHistory(historyPath, existing, newlyAppended);
    ctx.log(
      `info: appended ${newlyAppended.length} new workout(s) to ${historyPath} — history now has ${existing.length + newlyAppended.length} workouts`,
    );
  }

  ctx.log(
    `info: workouts-sync complete — recorded ${done}, failed ${failed} out of ${todo.length} new workouts`,
  );

  if (failed > 0) {
    throw new Error(`${failed} workout(s) failed to sync — see logs above`);
  }
}
