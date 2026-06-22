// Unit tests for the scheduler. There are NO standalone jobs: every job belongs
// to a workflow, so the scheduler only ever registers crons for WORKFLOWS. Its
// triggers must respect the live `enabled` flag (checked at fire-time, not
// registration), and a job must NEVER get a cron of its own (the workflow drives
// its members).
//
// To stay deterministic and avoid spawning/firing any REAL registry workflow (some
// are scheduled and metered), we swap the registry's `workflows` array for fakes
// for the duration of the test, then restore it. The enabled fake is pre-seeded
// with a 'running' workflow run so its fire short-circuits to "already running"
// (observable via the scheduler's own console.log) — nothing is spawned.
import { workflows } from '../jobs/registry.js';
import { createWorkflowRun, listWorkflowRunsForWorkflow, setWorkflowEnabled, syncWorkflow } from '../db/store.js';
import { nextWorkflowRun, startScheduler, stopScheduler } from './scheduler.js';
import type { WorkflowDefinition } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`); process.exitCode = 1; }
}

const EVERY_SECOND = '* * * * * *';
const ON: WorkflowDefinition = { name: 'test-sched-pipe-on', schedule: EVERY_SECOND, jobs: [{ job: 'test-sched-member' }] };
const OFF: WorkflowDefinition = { name: 'test-sched-pipe-off', schedule: EVERY_SECOND, jobs: [{ job: 'test-sched-member' }] };
const MANUAL: WorkflowDefinition = { name: 'test-sched-pipe-manual', schedule: null, jobs: [{ job: 'test-sched-member' }] };

// DB rows (FK + enabled flag) for the fake workflows.
for (const d of [ON, OFF, MANUAL]) syncWorkflow(d);
setWorkflowEnabled(OFF.name, false);
// Pre-seed a perpetual 'running' workflow run so the enabled workflow's fire is
// overlap-skipped (returns before spawning/notifying) — lets us observe a fire
// without side effects.
createWorkflowRun(ON.name, 'manual');

// Swap registry contents so ONLY our fakes are scheduled (never a real metered workflow).
const savedPipes = workflows.splice(0, workflows.length);
const origLog = console.log;
const captured: string[] = [];

try {
  workflows.push(ON, OFF, MANUAL);
  // Capture scheduler fire/registration logs while still printing test output.
  console.log = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); origLog(...a); };

  startScheduler();

  // Registration: scheduled workflows get a cron (enabled state is irrelevant to
  // registration — the gate is at fire-time); a manual (null-schedule) workflow does not.
  ok('enabled workflow is registered (nextWorkflowRun present)', nextWorkflowRun(ON.name) !== null);
  ok('disabled workflow is STILL registered (gate is at fire-time)', nextWorkflowRun(OFF.name) !== null);
  ok('manual-only workflow has no schedule', nextWorkflowRun(MANUAL.name) === null);
  // Jobs are NEVER scheduled on their own — there are no standalone crons (the
  // scheduler exposes no per-job next-run; only `nextWorkflowRun` exists).

  await sleep(2500); // cross ≥2 one-second boundaries → ≥2 fires each
  stopScheduler();

  const firedOn = captured.some((l) => l.includes(ON.name) && l.includes('skipped'));
  const firedOff = captured.some((l) => l.includes(OFF.name) && l.includes('skipped'));
  ok('ENABLED workflow fired (passed the gate → overlap-skipped, logged)', firedOn, captured.join('\n'));
  ok('DISABLED workflow never fired its action (gate blocked it)', !firedOff);
  // The disabled workflow created no NEW runs; the enabled one only has the pre-seeded running row.
  ok('disabled workflow created no run rows', listWorkflowRunsForWorkflow(OFF.name).length === 0);
  ok('enabled workflow spawned nothing (only the pre-seeded running row exists)', listWorkflowRunsForWorkflow(ON.name).length === 1);
  ok('cron stopped: nextWorkflowRun null after stopScheduler', nextWorkflowRun(ON.name) === null);
} finally {
  console.log = origLog;
  stopScheduler();
  // Restore the real registry contents for the rest of the suite.
  workflows.splice(0, workflows.length, ...savedPipes);
}

console.log(`\n${passed} scheduler test(s) passed.`);
