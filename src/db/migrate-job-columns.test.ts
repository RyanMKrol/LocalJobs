// Verifies the T070 column-drop migration: a legacy `jobs` table that still
// carries the per-job `schedule` and `enabled` columns has them dropped WITHOUT
// losing rows, and the migration is idempotent + safe on a fresh DB. A job is
// only ever a workflow member now, so those workflow-level concerns must not live
// on individual jobs. Builds its own throwaway DB (not the shared scratch DB).
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrateDropJobColumns } from './index.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  console.log(`  ✓ ${name}`);
  passed++;
}

const dbPath = join(tmpdir(), `lj-jobcol-test-${process.pid}.db`);
const db = new Database(dbPath);

// Stand up the OLD (pre-T070) `jobs` shape carrying schedule + enabled, with rows.
db.exec(`
  CREATE TABLE jobs (
    name        TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    schedule    TEXT,
    timeout_ms  INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
db.exec(`
  INSERT INTO jobs (name, description, schedule, timeout_ms, max_retries, enabled)
  VALUES ('ingest', 'foundation', '0 0 1 * *', 120000, 0, 0),
         ('resolve', 'resolver', '0 4 * * 0', 0, 1, 1);
`);

const cols = (): string[] =>
  (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name);

migrateDropJobColumns(db);

test('the per-job schedule + enabled columns are dropped', () => {
  assert.ok(!cols().includes('schedule'), 'schedule should be gone');
  assert.ok(!cols().includes('enabled'), 'enabled should be gone');
});

test('the remaining job columns survive', () => {
  for (const c of ['name', 'description', 'timeout_ms', 'max_retries', 'created_at']) {
    assert.ok(cols().includes(c), `${c} should remain`);
  }
});

test('all rows are preserved (no data loss)', () => {
  const rows = db.prepare('SELECT name, description, timeout_ms, max_retries FROM jobs ORDER BY name').all() as {
    name: string; description: string; timeout_ms: number; max_retries: number;
  }[];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: 'ingest', description: 'foundation', timeout_ms: 120000, max_retries: 0 });
  assert.deepEqual(rows[1], { name: 'resolve', description: 'resolver', timeout_ms: 0, max_retries: 1 });
});

test('idempotent: a second run is a no-op (no throw, rows intact)', () => {
  migrateDropJobColumns(db);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM jobs').get() as { c: number }).c, 2);
  assert.ok(!cols().includes('schedule') && !cols().includes('enabled'));
});

test('fresh DB with no jobs table: no-op, no throw', () => {
  const fresh = new Database(join(tmpdir(), `lj-jobcol-fresh-${process.pid}.db`));
  migrateDropJobColumns(fresh);
  const created = fresh.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = 'jobs'").get();
  assert.equal(created, undefined); // nothing created — schema bootstrap does that
  fresh.close();
});

db.close();
console.log(`\n${passed} job-column-drop migration test(s) passed.`);
