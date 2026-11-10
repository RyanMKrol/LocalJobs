// Several processes writing the ledger at the same moment must never fail with
// "database is locked".
//
// Every child job process writes the same SQLite file, and a workflow's parallel
// wave runs several at once while the daemon is writing their logs. A transaction
// that READS before it WRITES is the trap: SQLite starts it as a reader, and if
// another process commits in between, the upgrade to a writer fails immediately
// (the snapshot is stale, so waiting cannot help and the busy timeout does not
// apply). `markWorkItem` reads the item's previous state before upserting it, so
// its transaction must take the write lock up front (BEGIN IMMEDIATE), where the
// busy timeout DOES apply. This was caught live: the first run after the per-run
// snapshot landed failed its first attempt with exactly this error.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { db } from './index.js';
import { createWorkflowRun, markWorkItem, syncJob, syncWorkflow } from './store.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const self = fileURLToPath(import.meta.url);
const tsxBin = resolve(here, '..', '..', 'node_modules', '.bin', 'tsx');
const MARKS = 150;

if (process.argv[2] === '--writer') {
  // Child mode: hammer the ledger. Each mark reads the prior row, then writes two.
  const [, , , wfRun, who] = process.argv;
  for (let i = 0; i < MARKS; i++) {
    markWorkItem('cw-job', `shared-${i % 10}`, 'success', { attempts: i, detail: { name: `by ${who}`, i }, workflowRunId: wfRun, runId: who });
    markWorkItem('cw-job', `${who}-${i}`, 'success', { detail: { name: who }, workflowRunId: wfRun, runId: who });
  }
  process.exit(0);
}

syncJob({ name: 'cw-job', run: async () => {} });
syncWorkflow({ name: 'cw-wf', jobs: [{ job: 'cw-job' }] });
const wfRun = createWorkflowRun('cw-wf', 'manual');

const WRITERS = 5;
const writer = (n: number): Promise<{ code: number | null; err: string }> =>
  new Promise((done) => {
    const child = spawn(tsxBin, [self, '--writer', wfRun, `w${n}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, LOCALJOBS_DB: config.dbPath, LOCALJOBS_TEST: '1' },
    });
    let err = '';
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('close', (code) => done({ code, err }));
  });

const results = await Promise.all(Array.from({ length: WRITERS }, (_, i) => writer(i + 1)));
for (const [i, r] of results.entries()) {
  assert.equal(r.code, 0, `writer ${i + 1}/${WRITERS} failed:\n${r.err.split('\n').slice(0, 6).join('\n')}`);
}
const own = (db.prepare("SELECT COUNT(*) c FROM work_item_runs WHERE workflow_run_id = ? AND item_key NOT LIKE 'shared-%'").get(wfRun) as { c: number }).c;
assert.equal(own, WRITERS * MARKS, 'every write landed');
console.log(`  ✓ ${WRITERS} processes made ${WRITERS * MARKS * 2} ledger writes at once with no "database is locked"\n\n1 concurrent-writers test(s) passed.`);
