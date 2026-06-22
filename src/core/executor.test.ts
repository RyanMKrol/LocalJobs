// Unit tests for the executor's attempt loop: NDJSON event parsing, retries, and
// timeout-kill. We point `config.runJobScript` at a FAKE child script (written to a
// temp file) that emits canned NDJSON per scenario — so no real job runs and there
// are zero external calls. We drive the engine via `runJobForWorkflow` (which shares
// the same attempt/spawn machinery as `runJob` but does NOT notify), so these tests
// never spawn `osascript`/ntfy. Runs against the scratch DB (LOCALJOBS_DB).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { createRun, getLogs, getRun, listRunsForJob, syncJob } from '../db/store.js';
import { runJob, runJobForWorkflow } from './executor.js';
import type { JobDefinition } from './types.js';

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

// ── a fake child runner: branches on the job name (argv[2]) ──
//   timeout* → hang (wait to be SIGTERM'd)   retry* → fail twice then succeed (counter file)
//   fail*    → emit a failed result          else  → success + a mix of log/progress/raw events
const FAKE = `
import { readFileSync, writeFileSync } from 'node:fs';
const name = process.argv[2] ?? '';
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const done = (o, code) => process.stdout.write(JSON.stringify(o) + '\\n', () => process.exit(code));
if (name.startsWith('timeout')) {
  setTimeout(() => {}, 60000); // hang until the executor kills us
} else if (name.startsWith('retry')) {
  const file = process.env.LJ_TEST_COUNTER ?? '';
  let n = 0;
  try { n = parseInt(readFileSync(file, 'utf8'), 10) || 0; } catch {}
  n += 1; writeFileSync(file, String(n));
  if (n <= 2) { emit({ type: 'log', level: 'warn', message: 'attempt ' + n + ' failing' }); done({ type: 'result', status: 'failed', error: 'planned fail #' + n }, 1); }
  else { emit({ type: 'log', message: 'attempt ' + n + ' ok' }); done({ type: 'result', status: 'success' }, 0); }
} else if (name.startsWith('fail')) {
  emit({ type: 'log', level: 'error', message: 'boom' });
  done({ type: 'result', status: 'failed', error: 'planned failure' }, 1);
} else {
  emit({ type: 'log', message: 'hello from fake child' });
  emit({ type: 'progress', pct: 50, message: 'halfway' });
  process.stdout.write('a raw non-json stdout line\\n');
  emit({ type: 'log', level: 'warn', message: 'a warning line' });
  done({ type: 'result', status: 'success' }, 0);
}
`;

const dir = mkdtempSync(join(tmpdir(), 'lj-exec-'));
const fakePath = join(dir, 'fake-runner.mjs');
writeFileSync(fakePath, FAKE);
const counterFile = join(dir, 'counter.txt');
const PL = 'test-exec-workflow-run'; // runs.workflow_run_id has no FK — a synthetic id is fine
const origScript = config.runJobScript;
config.runJobScript = fakePath;

const def = (name: string, extra: Partial<JobDefinition> = {}): JobDefinition =>
  ({ name, timeoutMs: 0, maxRetries: 0, run: async () => {}, ...extra });

try {
  await test('success path: NDJSON log/progress/result parsed; non-JSON stdout still logged', async () => {
    const d = def('exec-success');
    syncJob(d);
    const { runId, status } = await runJobForWorkflow(d, PL);
    assert.equal(status, 'success');
    assert.ok(runId);
    const run = getRun(runId!);
    assert.equal(run?.status, 'success');
    assert.equal(run?.progress, 100); // finishRun forces 100 on success
    assert.equal(run?.progress_msg, 'halfway'); // last progress event message
    assert.equal(run?.exit_code, 0);
    const msgs = getLogs(runId!).map((l) => l.message);
    assert.ok(msgs.includes('hello from fake child'), 'info log captured');
    assert.ok(msgs.includes('a warning line'), 'warn log captured');
    assert.ok(msgs.some((m) => m.includes('a raw non-json stdout line')), 'non-JSON stdout still logged');
  });

  await test('failure path: failed result event → run failed with the reported error', async () => {
    const d = def('fail-exec');
    syncJob(d);
    const { runId, status } = await runJobForWorkflow(d, PL);
    assert.equal(status, 'failed');
    const run = getRun(runId!);
    assert.equal(run?.status, 'failed');
    assert.ok(run?.error?.includes('planned failure'), `error was: ${run?.error}`);
  });

  await test('retries: fails twice then succeeds within maxRetries → 3 attempts, final success', async () => {
    rmSync(counterFile, { force: true });
    process.env.LJ_TEST_COUNTER = counterFile;
    const d = def('retry-exec', { maxRetries: 2 });
    syncJob(d);
    const { runId, status } = await runJobForWorkflow(d, PL);
    delete process.env.LJ_TEST_COUNTER;
    assert.equal(status, 'success');
    const runs = listRunsForJob('retry-exec');
    assert.equal(runs.length, 3, 'one run row per attempt');
    assert.equal(getRun(runId!)?.status, 'success'); // the final attempt
    assert.equal(runs.filter((r) => r.status === 'failed').length, 2); // the first two
  });

  await test('timeout-kill: a hanging child is SIGTERM-killed and recorded as timeout', async () => {
    const d = def('timeout-exec', { timeoutMs: 400 });
    syncJob(d);
    const t0 = Date.now();
    const { runId, status } = await runJobForWorkflow(d, PL);
    assert.equal(status, 'timeout');
    assert.ok(Date.now() - t0 < 5000, 'killed promptly, not left to hang');
    const run = getRun(runId!);
    assert.equal(run?.status, 'timeout');
    assert.ok(/timeout/i.test(run?.error ?? ''), `error was: ${run?.error}`);
  });

  await test('overlap guard (runJob): an already-running job is skipped without spawning', async () => {
    const d = def('overlap-exec');
    syncJob(d);
    createRun('overlap-exec', 'manual'); // a perpetual 'running' row
    const res = await runJob(d, 'manual');
    assert.equal(res.skipped, true);
    assert.equal(res.runId, null);
    assert.equal(res.reason, 'already running');
    // only the manual running row exists — no spawn/attempt happened
    assert.equal(listRunsForJob('overlap-exec').length, 1);
  });

  await test('overlap guard (workflow member): a busy job records a skipped member run', async () => {
    const d = def('ploverlap-exec');
    syncJob(d);
    createRun('ploverlap-exec', 'manual'); // busy with a standalone run
    const { runId, status } = await runJobForWorkflow(d, PL);
    assert.equal(status, 'skipped');
    assert.equal(getRun(runId!)?.status, 'skipped');
  });
} finally {
  config.runJobScript = origScript;
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} executor test(s) passed.`);
