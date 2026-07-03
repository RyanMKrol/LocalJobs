// Tests for the workouts-sync artifact contract (T368) and that it makes the
// workflow executor derive a gate between hevy-sync and workouts-progress.
//
// Contract checks are exercised against SYNTHETIC fixtures in a temp dir (the
// real data/ folder is gitignored and absent in CI) — NO live Hevy API call.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactContract, GateResult } from '../../core/types.js';
import { buildDag, deriveGates } from '../../core/dag.js';
import { workoutsHistoryContract } from './contracts.js';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

function run(c: ArtifactContract): GateResult {
  const r = c.check();
  assert.ok(!(r instanceof Promise), 'contract check should be synchronous');
  return r;
}

const dir = mkdtempSync(join(tmpdir(), 'lj-workouts-contracts-'));
const f = (name: string) => join(dir, name);
const writeJson = (name: string, obj: unknown) => {
  const p = f(name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
};

const okWorkout = {
  id: 'w1',
  title: 'Push day',
  description: '',
  start_time: '2026-01-01T10:00:00Z',
  end_time: '2026-01-01T11:00:00Z',
  updated_at: '2026-01-01T11:00:00Z',
  created_at: '2026-01-01T10:00:00Z',
  exercises: [],
};

test('workouts-history: a well-formed non-empty array passes', () => {
  const p = writeJson('history-ok.json', [okWorkout]);
  const r = run(workoutsHistoryContract(p));
  assert.equal(r.ok, true, r.violations?.join('; '));
});

test('workouts-history: an empty array is legitimate and passes', () => {
  const p = writeJson('history-empty.json', []);
  const r = run(workoutsHistoryContract(p));
  assert.equal(r.ok, true, r.violations?.join('; '));
});

test('workouts-history: a missing file fails', () => {
  const r = run(workoutsHistoryContract(f('does-not-exist.json')));
  assert.equal(r.ok, false);
});

test('workouts-history: invalid JSON fails', () => {
  const p = f('history-bad.json');
  writeFileSync(p, '{not valid json');
  const r = run(workoutsHistoryContract(p));
  assert.equal(r.ok, false);
});

test('workouts-history: a non-array top-level value fails', () => {
  const p = writeJson('history-not-array.json', { workouts: [okWorkout] });
  const r = run(workoutsHistoryContract(p));
  assert.equal(r.ok, false);
});

test('workouts-history: an entry missing id fails', () => {
  const bad = { ...okWorkout, id: undefined };
  const p = writeJson('history-missing-id.json', [bad]);
  const r = run(workoutsHistoryContract(p));
  assert.equal(r.ok, false);
});

test('workouts-sync: gates derive between hevy-sync and workouts-progress (count > 0)', () => {
  const dag = buildDag([
    { job: 'hevy-sync' },
    { job: 'workouts-progress', dependsOn: ['hevy-sync'] },
  ]);
  const produces = new Map<string, string[]>([
    ['hevy-sync', ['workouts-history']],
    ['workouts-progress', []],
  ]);
  const consumes = new Map<string, string[]>([
    ['hevy-sync', []],
    ['workouts-progress', ['workouts-history']],
  ]);
  const gates = deriveGates(dag, produces, consumes);
  assert.equal(gates.length, 1);
  assert.deepEqual(gates.map((g) => g.key), ['workouts-history']);
});

rmSync(dir, { recursive: true, force: true });

if (process.exitCode !== 1) {
  console.log(`workouts-sync contracts: ${passed} passed`);
}
