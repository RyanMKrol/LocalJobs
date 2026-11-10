// The data the workouts-sync stages hand to each other.
//
//   hevy-sync ──history──▶ workouts-progress ──▶ data, reports
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { dirArtifact, fromChecks, jsonArtifact } from '../../engine/index.js';
import type { HevyWorkout } from './stages/hevy-sync.js';
import type { ProgressData } from './stages/workouts-progress.js';

/**
 * Every Hevy workout synced so far. A store that grows: a run with no new
 * workout leaves it as it was. Empty is a legitimate state (a fresh install).
 */
export const workoutsHistory = jsonArtifact<HevyWorkout[]>({
  key: 'workouts-history',
  description: 'The full history of Hevy workouts synced so far.',
  shape: {
    summary: 'The full history of Hevy workouts synced so far (may legitimately be empty on a fresh install).',
    format: 'JSON file (workouts-history.json), a plain array, not wrapped in an object',
    expectations: [
      { label: 'A plain top-level array', detail: 'The top-level JSON value is an array (zero or more workouts).' },
      { label: 'Every workout has an id + an exercises array', detail: 'Each workout (if any) has a text id and an exercises array.' },
    ],
  },
  check(v) {
    const isArr = Array.isArray(v);
    if (!isArr) return fromChecks([{ label: 'A plain top-level array', ok: false, actual: typeof v }]);
    const bad = v.find((w) => !w || typeof w.id !== 'string' || !w.id || !Array.isArray(w.exercises));
    return fromChecks([
      { label: 'A plain top-level array', ok: true, actual: 'array' },
      { label: 'Every workout has an id + an exercises array', ok: !bad, actual: bad ? `bad entry: ${JSON.stringify(bad).slice(0, 200)}` : v.length ? 'all entries well-formed' : 'no workouts to check' },
    ], `${v.length} workout(s)`);
  },
  summary: (v) => `${v.length} workout(s)`,
  // Newest first, as Hevy lists them.
  items: (v) => [...v].sort((a, b) => String(b.start_time).localeCompare(String(a.start_time))).map((w) => ({
    id: w.id,
    title: w.title,
    fields: [{ label: 'Date', value: String(w.start_time).slice(0, 10) }, { label: 'Exercises', value: String(w.exercises.length) }],
  })),
});

/** The numbers behind this month's report: per-exercise baseline against current. */
export const progressData = jsonArtifact<ProgressData>({
  key: 'workouts-progress-data',
  description: 'The computed comparison behind the report: each exercise this month against six months ago.',
  check: (v) => fromChecks([{ label: 'has a list of exercises', ok: Array.isArray(v?.exercises), actual: Array.isArray(v?.exercises) ? `${v.exercises.length} exercise(s)` : 'no exercises list' }]),
  summary: (v) => `${v.exercises.length} exercise(s), ${v.currentPeriod} against ${v.baselinePeriod}`,
  items: (v) => v.exercises.map((e) => ({
    id: e.exerciseTemplateId,
    title: e.title,
    fields: [
      ...(e.baseline ? [{ label: 'Then', value: `${e.baseline.bestSetWeightKg}kg x${e.baseline.bestSetReps}` }] : []),
      ...(e.current ? [{ label: 'Now', value: `${e.current.bestSetWeightKg}kg x${e.current.bestSetReps}` }] : []),
    ],
  })),
});

/** The monthly narrative reports. One per month; a month is rewritten in place. */
export const progressReports = dirArtifact({
  key: 'workouts-progress-reports',
  description: 'The monthly progress reports: workouts-progress-<YYYY-MM>.md.',
  format: 'markdown',
  // The reports share data/out with the history and the data file: only the reports are this artifact.
  files: (name) => /^workouts-progress-.*\.md$/.test(name),
  check(d) {
    const empty = d.files.filter((f) => statSync(join(d.path, f)).size === 0);
    return fromChecks([{ label: 'no report is empty', ok: empty.length === 0, actual: empty.length ? `empty: ${empty.join(', ')}` : `${d.files.length} report(s)` }], `${d.files.length} report(s)`);
  },
  count: (d) => d.files.length,
  summary: (d) => `${d.files.length} report(s)`,
  items: (d) => [...d.files].reverse().map((f) => ({
    id: f, title: f.replace(/^workouts-progress-|\.md$/g, ''), preview: { path: join(d.path, f), format: 'markdown' },
  })),
});
