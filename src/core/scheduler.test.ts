// Unit tests for the scheduler: croner triggers must respect the live `enabled`
// flag (checked at fire-time, not registration), and a pipeline-member job must
// NOT get its own cron (the pipeline drives it).
//
// To stay deterministic and avoid spawning/firing any REAL registry job (some are
// scheduled and metered), we swap the registry's `jobs`/`pipelines` arrays for
// fakes for the duration of the test, then restore them. The enabled fake is
// pre-seeded with a 'running' row so its fire short-circuits to "already running"
// (observable via the scheduler's own console.log) — no child process is spawned.
import assert from 'node:assert/strict';
import { jobs, pipelines } from '../jobs/registry.js';
import { createRun, listRunsForJob, setJobEnabled, syncJob } from '../db/store.js';
import { nextPipelineRun, nextRun, startScheduler, stopScheduler } from './scheduler.js';
import type { JobDefinition, PipelineDefinition } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`); process.exitCode = 1; }
}

const EVERY_SECOND = '* * * * * *';
const ON: JobDefinition = { name: 'test-sched-enabled', schedule: EVERY_SECOND, run: async () => {} };
const OFF: JobDefinition = { name: 'test-sched-disabled', schedule: EVERY_SECOND, run: async () => {} };
const MEMBER: JobDefinition = { name: 'test-sched-member', schedule: EVERY_SECOND, run: async () => {} };
const PIPE: PipelineDefinition = { name: 'test-sched-pipe', jobs: [{ job: 'test-sched-member' }] };

// DB rows (FK + enabled flag) for the fakes.
for (const d of [ON, OFF, MEMBER]) syncJob(d);
setJobEnabled(OFF.name, false);
// Pre-seed a perpetual 'running' run so the enabled job's fire is overlap-skipped
// (returns before spawning/notifying) — lets us observe a fire without side effects.
createRun(ON.name, 'manual');

// Swap registry contents so ONLY our fakes are scheduled (never a real metered job).
const savedJobs = jobs.splice(0, jobs.length);
const savedPipes = pipelines.splice(0, pipelines.length);
const origLog = console.log;
const captured: string[] = [];

try {
  jobs.push(ON, OFF, MEMBER);
  pipelines.push(PIPE);
  // Capture scheduler fire/registration logs while still printing test output.
  console.log = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); origLog(...a); };

  startScheduler();

  // Registration: scheduled non-member jobs get a cron (enabled state is irrelevant
  // to registration — the gate is at fire-time); the member's cron is suppressed.
  ok('enabled job is registered (nextRun present)', nextRun(ON.name) !== null);
  ok('disabled job is STILL registered (gate is at fire-time)', nextRun(OFF.name) !== null);
  ok('pipeline-member job gets no own cron', nextRun(MEMBER.name) === null);
  ok('manual-only pipeline has no schedule', nextPipelineRun(PIPE.name) === null);

  await sleep(2500); // cross ≥2 one-second boundaries → ≥2 fires each
  stopScheduler();

  const firedOn = captured.some((l) => l.includes(ON.name) && l.includes('skipped'));
  const firedOff = captured.some((l) => l.includes(OFF.name) && l.includes('skipped'));
  ok('ENABLED job fired (passed the gate → overlap-skipped, logged)', firedOn, captured.join('\n'));
  ok('DISABLED job never fired its action (gate blocked it)', !firedOff);
  ok('disabled job created no run rows', listRunsForJob(OFF.name).length === 0);
  ok('enabled job spawned nothing (only the pre-seeded running row exists)', listRunsForJob(ON.name).length === 1);
  ok('cron stopped: nextRun null after stopScheduler', nextRun(ON.name) === null);
} finally {
  console.log = origLog;
  stopScheduler();
  // Restore the real registry contents for the rest of the suite.
  jobs.splice(0, jobs.length, ...savedJobs);
  pipelines.splice(0, pipelines.length, ...savedPipes);
}

console.log(`\n${passed} scheduler test(s) passed.`);
