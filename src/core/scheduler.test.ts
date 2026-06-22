// Unit tests for the scheduler. There are NO standalone jobs: every job belongs
// to a pipeline, so the scheduler only ever registers crons for PIPELINES. Its
// triggers must respect the live `enabled` flag (checked at fire-time, not
// registration), and a job must NEVER get a cron of its own (the pipeline drives
// its members).
//
// To stay deterministic and avoid spawning/firing any REAL registry pipeline (some
// are scheduled and metered), we swap the registry's `pipelines` array for fakes
// for the duration of the test, then restore it. The enabled fake is pre-seeded
// with a 'running' pipeline run so its fire short-circuits to "already running"
// (observable via the scheduler's own console.log) — nothing is spawned.
import { pipelines } from '../jobs/registry.js';
import { createPipelineRun, listPipelineRunsForPipeline, setPipelineEnabled, syncPipeline } from '../db/store.js';
import { nextPipelineRun, nextRun, startScheduler, stopScheduler } from './scheduler.js';
import type { PipelineDefinition } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`); process.exitCode = 1; }
}

const EVERY_SECOND = '* * * * * *';
const ON: PipelineDefinition = { name: 'test-sched-pipe-on', schedule: EVERY_SECOND, jobs: [{ job: 'test-sched-member' }] };
const OFF: PipelineDefinition = { name: 'test-sched-pipe-off', schedule: EVERY_SECOND, jobs: [{ job: 'test-sched-member' }] };
const MANUAL: PipelineDefinition = { name: 'test-sched-pipe-manual', schedule: null, jobs: [{ job: 'test-sched-member' }] };

// DB rows (FK + enabled flag) for the fake pipelines.
for (const d of [ON, OFF, MANUAL]) syncPipeline(d);
setPipelineEnabled(OFF.name, false);
// Pre-seed a perpetual 'running' pipeline run so the enabled pipeline's fire is
// overlap-skipped (returns before spawning/notifying) — lets us observe a fire
// without side effects.
createPipelineRun(ON.name, 'manual');

// Swap registry contents so ONLY our fakes are scheduled (never a real metered pipeline).
const savedPipes = pipelines.splice(0, pipelines.length);
const origLog = console.log;
const captured: string[] = [];

try {
  pipelines.push(ON, OFF, MANUAL);
  // Capture scheduler fire/registration logs while still printing test output.
  console.log = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); origLog(...a); };

  startScheduler();

  // Registration: scheduled pipelines get a cron (enabled state is irrelevant to
  // registration — the gate is at fire-time); a manual (null-schedule) pipeline does not.
  ok('enabled pipeline is registered (nextPipelineRun present)', nextPipelineRun(ON.name) !== null);
  ok('disabled pipeline is STILL registered (gate is at fire-time)', nextPipelineRun(OFF.name) !== null);
  ok('manual-only pipeline has no schedule', nextPipelineRun(MANUAL.name) === null);
  // Jobs are NEVER scheduled on their own — there are no standalone crons.
  ok('a member job gets no own cron', nextRun('test-sched-member') === null);

  await sleep(2500); // cross ≥2 one-second boundaries → ≥2 fires each
  stopScheduler();

  const firedOn = captured.some((l) => l.includes(ON.name) && l.includes('skipped'));
  const firedOff = captured.some((l) => l.includes(OFF.name) && l.includes('skipped'));
  ok('ENABLED pipeline fired (passed the gate → overlap-skipped, logged)', firedOn, captured.join('\n'));
  ok('DISABLED pipeline never fired its action (gate blocked it)', !firedOff);
  // The disabled pipeline created no NEW runs; the enabled one only has the pre-seeded running row.
  ok('disabled pipeline created no run rows', listPipelineRunsForPipeline(OFF.name).length === 0);
  ok('enabled pipeline spawned nothing (only the pre-seeded running row exists)', listPipelineRunsForPipeline(ON.name).length === 1);
  ok('cron stopped: nextPipelineRun null after stopScheduler', nextPipelineRun(ON.name) === null);
} finally {
  console.log = origLog;
  stopScheduler();
  // Restore the real registry contents for the rest of the suite.
  pipelines.splice(0, pipelines.length, ...savedPipes);
}

console.log(`\n${passed} scheduler test(s) passed.`);
