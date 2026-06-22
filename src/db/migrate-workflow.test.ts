// Verifies the T038 rename migration: a legacy DB with `pipeline_*` tables/columns
// is moved to `workflow_*` WITHOUT losing rows, and is idempotent. Builds its own
// throwaway DB (not the shared scratch DB) so it exercises the legacy layout.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateWorkflowRename } from './index.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  console.log(`  ✓ ${name}`);
  passed++;
}

const dbPath = join(tmpdir(), `lj-migrate-test-${process.pid}.db`);
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

// Stand up the OLD (pre-T038) shape with the relevant pipeline_* objects + a
// `runs` table carrying the legacy member-link column.
db.exec(`
  CREATE TABLE runs (id TEXT PRIMARY KEY, job_name TEXT, pipeline_run_id TEXT);
  CREATE INDEX idx_runs_pipeline ON runs(pipeline_run_id);
  CREATE TABLE pipelines (name TEXT PRIMARY KEY, description TEXT, schedule TEXT, enabled INTEGER);
  CREATE TABLE pipeline_jobs (
    pipeline_name TEXT NOT NULL, job_name TEXT NOT NULL, depends_on TEXT DEFAULT '[]',
    PRIMARY KEY (pipeline_name, job_name),
    FOREIGN KEY (pipeline_name) REFERENCES pipelines(name)
  );
  CREATE TABLE pipeline_runs (
    id TEXT PRIMARY KEY, pipeline_name TEXT NOT NULL, status TEXT,
    FOREIGN KEY (pipeline_name) REFERENCES pipelines(name)
  );
  CREATE INDEX idx_pipeline_runs_name ON pipeline_runs(pipeline_name);
  CREATE TABLE pipeline_run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pipeline_run_id TEXT NOT NULL, message TEXT,
    FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id)
  );
  CREATE INDEX idx_pipeline_run_logs ON pipeline_run_logs(pipeline_run_id, id);
`);
db.exec(`
  INSERT INTO pipelines VALUES ('places', 'places dag', '0 3 * * *', 1);
  INSERT INTO pipeline_jobs VALUES ('places', 'ingest', '[]');
  INSERT INTO pipeline_runs VALUES ('pr1', 'places', 'success');
  INSERT INTO pipeline_run_logs (pipeline_run_id, message) VALUES ('pr1', 'stage start');
  INSERT INTO runs VALUES ('run1', 'ingest', 'pr1');
`);

migrateWorkflowRename(db);

const hasTable = (n: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(n);
const cols = (t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

test('legacy pipeline_* tables are gone, workflow_* tables exist', () => {
  for (const old of ['pipelines', 'pipeline_jobs', 'pipeline_runs', 'pipeline_run_logs']) {
    assert.equal(hasTable(old), false, `${old} should be renamed away`);
  }
  for (const w of ['workflows', 'workflow_jobs', 'workflow_runs', 'workflow_run_logs']) {
    assert.equal(hasTable(w), true, `${w} should exist`);
  }
});

test('columns are renamed pipeline_* → workflow_*', () => {
  assert.ok(cols('workflow_jobs').includes('workflow_name'));
  assert.ok(!cols('workflow_jobs').includes('pipeline_name'));
  assert.ok(cols('workflow_runs').includes('workflow_name'));
  assert.ok(cols('workflow_run_logs').includes('workflow_run_id'));
  assert.ok(cols('runs').includes('workflow_run_id'));
  assert.ok(!cols('runs').includes('pipeline_run_id'));
});

test('all rows are preserved (no data loss)', () => {
  const wf = db.prepare('SELECT * FROM workflows').get() as { name: string; schedule: string };
  assert.equal(wf.name, 'places');
  assert.equal(wf.schedule, '0 3 * * *');
  const job = db.prepare('SELECT * FROM workflow_jobs').get() as { workflow_name: string };
  assert.equal(job.workflow_name, 'places');
  const wr = db.prepare('SELECT * FROM workflow_runs').get() as { id: string; workflow_name: string };
  assert.equal(wr.workflow_name, 'places');
  const log = db.prepare('SELECT * FROM workflow_run_logs').get() as { workflow_run_id: string };
  assert.equal(log.workflow_run_id, 'pr1');
  const run = db.prepare('SELECT * FROM runs').get() as { workflow_run_id: string };
  assert.equal(run.workflow_run_id, 'pr1');
});

test('legacy indexes are dropped', () => {
  for (const idx of ['idx_pipeline_runs_name', 'idx_pipeline_run_logs', 'idx_runs_pipeline']) {
    const found = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?").get(idx);
    assert.equal(found, undefined, `${idx} should be dropped`);
  }
});

test('idempotent: a second run is a no-op (no throw, rows intact)', () => {
  migrateWorkflowRename(db);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM workflows').get() as { c: number }).c, 1);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM workflow_runs').get() as { c: number }).c, 1);
});

test('fresh DB with no legacy tables: no-op, no throw', () => {
  const fresh = new Database(join(tmpdir(), `lj-migrate-fresh-${process.pid}.db`));
  migrateWorkflowRename(fresh);
  const created = fresh
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = 'workflows'")
    .get();
  assert.equal(created, undefined); // nothing created — schema bootstrap does that
  fresh.close();
});

db.close();
console.log(`\n${passed} workflow-rename migration test(s) passed.`);
