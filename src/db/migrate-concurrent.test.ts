// Engine v2 migration must be safe when SEVERAL processes open the same
// not-yet-migrated database at the same moment.
//
// Why this exists: `src/db/index.ts` is imported by every child job process, not
// only the daemon, so its migrations run in each of them. A workflow's parallel
// wave spawns several children at once. A "does the column exist? no -> ALTER"
// guard that is not atomic across processes lets two of them both decide to add
// the column, and the loser dies on "duplicate column name" before its job even
// starts. migrateEngineV2 takes the write lock (BEGIN IMMEDIATE) before checking,
// so this must never happen. The test strips the v2 columns back off a real DB
// and opens it from several processes at once.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { hasColumn, openDb } from './index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const self = fileURLToPath(import.meta.url);
const tsxBin = resolve(here, '..', '..', 'node_modules', '.bin', 'tsx');

if (process.argv[2] === '--open') {
  // Child mode: just run the real bootstrap+migration path against the given file.
  const db = openDb(process.argv[3]);
  if (!hasColumn(db, 'work_item_runs', 'run_id')) process.exit(3);
  db.close();
  process.exit(0);
}

const dbPath = join(tmpdir(), `lj-concurrent-migrate-${process.pid}.db`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true }); };
cleanup();

// Build a current-shape DB, then put it back into its PRE-v2 shape.
{
  openDb(dbPath).close();
  const db = new Database(dbPath);
  db.exec('DROP INDEX IF EXISTS idx_work_item_runs_runid');
  for (const c of ['run_id', 'cycle', 'status', 'attempts', 'detail', 'title', 'input_job', 'input_key', 'at_ms']) {
    db.exec(`ALTER TABLE work_item_runs DROP COLUMN ${c}`);
  }
  for (const c of ['cycle', 'outcome_reason', 'queued_at_ms', 'started_at_ms', 'finished_at_ms', 'gate_ms']) {
    db.exec(`ALTER TABLE runs DROP COLUMN ${c}`);
  }
  for (const c of ['end_reason', 'cycles', 'resumed_from']) db.exec(`ALTER TABLE workflow_runs DROP COLUMN ${c}`);
  assert.equal(hasColumn(db, 'work_item_runs', 'run_id'), false, 'precondition: DB is back in its pre-v2 shape');
  db.close();
}

const PROCS = 6;
const open = (): Promise<{ code: number | null; err: string }> =>
  new Promise((done) => {
    const child = spawn(tsxBin, [self, '--open', dbPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, LOCALJOBS_TEST: '1' },
    });
    let err = '';
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('close', (code) => done({ code, err }));
  });

const results = await Promise.all(Array.from({ length: PROCS }, open));
try {
  for (const [i, r] of results.entries()) {
    assert.equal(r.code, 0, `process ${i + 1}/${PROCS} failed to open the DB during a concurrent migration:\n${r.err}`);
  }
  const db = new Database(dbPath);
  assert.equal(hasColumn(db, 'runs', 'outcome_reason'), true);
  assert.equal(hasColumn(db, 'workflow_runs', 'end_reason'), true);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_work_item_runs_runid'").get());
  db.close();
  console.log(`  ✓ ${PROCS} processes opened a pre-v2 DB at once; all migrated cleanly\n\n1 concurrent-migration test(s) passed.`);
} finally {
  cleanup();
}
