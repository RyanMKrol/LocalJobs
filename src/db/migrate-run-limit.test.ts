// Verifies the T094 run-limit / input-lineage migration: a legacy DB whose
// `work_items` and `workflow_runs` tables predate the lineage columns gets them
// added additively, existing work_items are backfilled to root_key = item_key
// (each is its own root), the (job_name, root_key) index is created, and the
// migration is idempotent + safe on a fresh DB. Builds its own throwaway DB.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateRunLimitLineage } from './index.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  console.log(`  ✓ ${name}`);
  passed++;
}

const dbPath = join(tmpdir(), `lj-runlimit-test-${process.pid}.db`);
const db = new Database(dbPath);

// Stand up the OLD (pre-T094) shapes WITHOUT the lineage columns, with rows.
db.exec(`
  CREATE TABLE work_items (
    job_name   TEXT NOT NULL,
    item_key   TEXT NOT NULL,
    status     TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 1,
    detail     TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (job_name, item_key)
  );
  CREATE TABLE workflow_runs (
    id            TEXT PRIMARY KEY,
    workflow_name TEXT NOT NULL,
    status        TEXT NOT NULL,
    trigger       TEXT NOT NULL,
    progress      INTEGER NOT NULL DEFAULT 0,
    progress_msg  TEXT NOT NULL DEFAULT '',
    started_at    TEXT, finished_at TEXT, duration_ms INTEGER
  );
  INSERT INTO work_items (job_name, item_key, status, attempts) VALUES
    ('resolve', 'cid-1', 'success', 1),
    ('resolve', 'cid-2', 'failed', 2);
  INSERT INTO workflow_runs (id, workflow_name, status, trigger) VALUES
    ('wr-1', 'places', 'success', 'manual');
`);

const wiCols = (): string[] =>
  (db.prepare('PRAGMA table_info(work_items)').all() as { name: string }[]).map((c) => c.name);
const wrCols = (): string[] =>
  (db.prepare('PRAGMA table_info(workflow_runs)').all() as { name: string }[]).map((c) => c.name);

migrateRunLimitLineage(db);

test('work_items gains root_key + parent_key columns', () => {
  assert.ok(wiCols().includes('root_key'), 'root_key added');
  assert.ok(wiCols().includes('parent_key'), 'parent_key added');
});

test('existing work_items are backfilled to root_key = item_key (each its own root)', () => {
  const rows = db.prepare('SELECT item_key, root_key, parent_key FROM work_items ORDER BY item_key').all() as {
    item_key: string; root_key: string; parent_key: string | null;
  }[];
  assert.deepEqual(rows, [
    { item_key: 'cid-1', root_key: 'cid-1', parent_key: null },
    { item_key: 'cid-2', root_key: 'cid-2', parent_key: null },
  ]);
});

test('the (job_name, root_key) index is created', () => {
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_work_items_root'").get();
  assert.ok(idx, 'idx_work_items_root present');
});

test('workflow_runs gains run_limit + selected_roots (NULL = unlimited)', () => {
  assert.ok(wrCols().includes('run_limit'), 'run_limit added');
  assert.ok(wrCols().includes('selected_roots'), 'selected_roots added');
  const r = db.prepare('SELECT run_limit, selected_roots FROM workflow_runs WHERE id = ?').get('wr-1') as {
    run_limit: number | null; selected_roots: string | null;
  };
  assert.equal(r.run_limit, null, 'pre-existing run defaults to unlimited');
  assert.equal(r.selected_roots, null);
});

test('idempotent: a second run is a no-op (no throw, rows + backfill intact)', () => {
  migrateRunLimitLineage(db);
  const n = (db.prepare('SELECT COUNT(*) c FROM work_items').get() as { c: number }).c;
  assert.equal(n, 2);
  assert.equal((db.prepare('SELECT root_key FROM work_items WHERE item_key = ?').get('cid-1') as { root_key: string }).root_key, 'cid-1');
});

test('fresh DB with no relevant tables: no-op, no throw', () => {
  const fresh = new Database(join(tmpdir(), `lj-runlimit-fresh-${process.pid}.db`));
  migrateRunLimitLineage(fresh); // tables absent → guarded skip
  assert.equal(fresh.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = 'work_items'").get(), undefined);
  fresh.close();
});

db.close();
console.log(`\n${passed} run-limit migration test(s) passed.`);
