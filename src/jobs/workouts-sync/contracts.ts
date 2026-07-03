// Typed-artifact contract for the workouts-sync workflow stage boundary.
//
// Unlike places/perfumes/stocks-sync, workouts-sync has no config.ts — it reads
// the default artifact path straight from the producing stage's own module
// (defaultHistoryPath), matching how workouts-progress.ts itself already does.
//
// Keys are shared across the producing job's `produces` and the consuming
// job's `consumes` so the workflow executor derives a gate at this edge:
//   hevy-sync ──workouts-history──▶ workouts-progress
import { existsSync, readFileSync } from 'node:fs';
import type { ArtifactContract, ExpectationResult, GateResult } from '../../core/types.js';
import { defaultHistoryPath } from './stages/hevy-sync.js';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function readJson(file: string): { obj?: unknown; violation?: string } {
  if (!existsSync(file)) return { violation: `file missing: ${file}` };
  try {
    return { obj: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (e) {
    return { violation: `not valid JSON — ${errMsg(e)}` };
  }
}

/**
 * Build a GateResult from per-expectation results: `ok` iff every expectation
 * passed, with `violations` derived from the failures so the executor's gate
 * enforcement (which reads `ok`/`violations`) is unchanged.
 */
function fromChecks(checks: ExpectationResult[], sample?: string): GateResult {
  const failed = checks.filter((c) => !c.ok);
  const ok = failed.length === 0;
  return {
    ok,
    violations: ok ? undefined : failed.map((c) => `${c.label}: ${c.actual ?? 'failed'}`),
    checks,
    sample,
    detail: sample,
  };
}

const HISTORY_EXP = {
  json: 'A readable JSON file',
  array: 'A plain top-level array',
  entries: 'Every workout has an id + an exercises array',
};

/**
 * hevy-sync → workouts-progress boundary: workouts-history.json. Must parse
 * and be a plain JSON array of HevyWorkout records — every entry, if any, has
 * a non-empty string `id` and an `exercises` array. A ZERO-length array is a
 * legitimate state (a fresh install with no synced workouts yet) and passes.
 */
export function workoutsHistoryContract(file: string = defaultHistoryPath): ArtifactContract {
  return {
    key: 'workouts-history',
    description: 'hevy-sync output: workouts-history.json — a JSON array of the full synced workout history.',
    shape: {
      summary: 'The full history of Hevy workouts synced so far (may legitimately be empty on a fresh install).',
      format: 'JSON file (workouts-history.json), a plain array — not wrapped in an object',
      expectations: [
        { label: HISTORY_EXP.json, detail: 'The hand-off file exists and parses as JSON.' },
        { label: HISTORY_EXP.array, detail: 'The top-level JSON value is an array (zero or more workouts).' },
        { label: HISTORY_EXP.entries, detail: 'Each workout (if any) has a text id and an exercises array.' },
      ],
    },
    check(): GateResult {
      const checks: ExpectationResult[] = [];
      const { obj, violation } = readJson(file);
      if (violation) {
        checks.push({ label: HISTORY_EXP.json, ok: false, actual: violation });
        return fromChecks(checks);
      }
      checks.push({ label: HISTORY_EXP.json, ok: true, actual: 'valid JSON' });
      const isArr = Array.isArray(obj);
      checks.push({ label: HISTORY_EXP.array, ok: isArr, actual: isArr ? 'array' : `${typeof obj}` });
      if (!isArr) return fromChecks(checks);
      const arr = obj as Record<string, unknown>[];
      if (arr.length === 0) {
        checks.push({ label: HISTORY_EXP.entries, ok: true, actual: 'no workouts to check' });
        return fromChecks(checks, '0 workout(s)');
      }
      const bad = arr.find(
        (w) => !w || typeof w.id !== 'string' || !w.id || !Array.isArray(w.exercises),
      );
      checks.push({
        label: HISTORY_EXP.entries,
        ok: !bad,
        actual: bad ? `bad entry: ${JSON.stringify(bad)}` : 'all entries well-formed',
      });
      const titles = arr.slice(0, 3).map((w) => JSON.stringify(w.title)).join(', ');
      return fromChecks(checks, `${arr.length} workout(s)${titles ? ` · e.g. ${titles}` : ''}`);
    },
  };
}
