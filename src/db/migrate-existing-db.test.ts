// T098 regression guard: openDb()'s FULL bootstrap+migration path must survive an
// EXISTING (non-fresh) database whose schema predates the newer additive migrations.
//
// Why this exists: the unit suite always starts from a fresh/empty scratch DB, so
// schema.sql's `CREATE TABLE` already carries every newer column — that path can
// NEVER catch a bootstrap statement that references a column only a LATER migration
// adds. The T094 regression (fixed in 2748c58) was exactly that: schema.sql created
// `idx_work_items_root` on `work_items(root_key)`, but on a live/existing DB the
// `root_key` column is only added by migrateRunLimitLineage(), which runs AFTER the
// schema bootstrap — so `db.exec(schema)` threw "no such column: root_key" and the
// daemon crash-looped on every start, while CI stayed green.
//
// This test seeds a realistic LEGACY snapshot (core tables in their pre-migration
// shape, WITHOUT the newer columns/indexes, plus representative rows), then runs the
// REAL openDb() against THAT file and asserts it does not throw and ends correctly
// migrated. Pointed at the pre-fix buggy schema.sql it FAILS at the `db.exec(schema)`
// step — so ANY future "bootstrap index/constraint on a migration-added column"
// ordering violation trips it, not just the original bug. Builds its own throwaway DB.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { openDb } from './index.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  console.log(`  ✓ ${name}`);
  passed++;
}

const dbPath = join(tmpdir(), `lj-existing-db-test-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });

// ── Seed a LEGACY snapshot: every core table, but in its OLD pre-migration shape ──
// (no newer columns/indexes the additive migrations add) + a few representative rows.
{
  const legacy = new Database(dbPath);
  legacy.pragma('journal_mode = WAL');
  legacy.pragma('foreign_keys = ON');
  legacy.exec(`
    -- jobs: PRE-T070 shape (still carries the now-dropped schedule + enabled columns).
    CREATE TABLE jobs (
      name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '',
      timeout_ms INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 0,
      schedule TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- runs: PRE-workflow_run_id shape (no member-link column, no idx_runs_workflow).
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, job_name TEXT NOT NULL, status TEXT NOT NULL, trigger TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1, progress INTEGER NOT NULL DEFAULT 0,
      progress_msg TEXT NOT NULL DEFAULT '', started_at TEXT, finished_at TEXT,
      duration_ms INTEGER, exit_code INTEGER, error TEXT,
      FOREIGN KEY (job_name) REFERENCES jobs(name)
    );
    CREATE INDEX idx_runs_job ON runs(job_name, started_at DESC);
    CREATE INDEX idx_runs_status ON runs(status);
    CREATE TABLE run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now')), level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL, FOREIGN KEY (run_id) REFERENCES runs(id)
    );
    CREATE INDEX idx_logs_run ON run_logs(run_id, id);
    -- work_items: PRE-T094 shape (no root_key/parent_key, no idx_work_items_root).
    -- This is the exact table the buggy schema.sql indexed before the column existed.
    CREATE TABLE work_items (
      job_name TEXT NOT NULL, item_key TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1, detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (job_name, item_key)
    );
    CREATE INDEX idx_work_items_status ON work_items(job_name, status);
    CREATE TABLE job_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_name TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_job_usage ON job_usage(job_name, ts);
    CREATE TABLE workflows (
      name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', schedule TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE workflow_jobs (
      workflow_name TEXT NOT NULL, job_name TEXT NOT NULL, depends_on TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (workflow_name, job_name), FOREIGN KEY (workflow_name) REFERENCES workflows(name)
    );
    -- workflow_runs: PRE-T094 shape (no run_limit/selected_roots).
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL, status TEXT NOT NULL, trigger TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0, progress_msg TEXT NOT NULL DEFAULT '',
      started_at TEXT, finished_at TEXT, duration_ms INTEGER,
      FOREIGN KEY (workflow_name) REFERENCES workflows(name)
    );
    CREATE INDEX idx_workflow_runs_name ON workflow_runs(workflow_name, started_at DESC);
    CREATE TABLE workflow_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_run_id TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now')), level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL, FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id)
    );
    CREATE INDEX idx_workflow_run_logs ON workflow_run_logs(workflow_run_id, id);
    -- services: PRE-T018 shape (no limits_overridden column).
    CREATE TABLE services (
      name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', rate_per_minute INTEGER,
      daily_cap INTEGER, monthly_cap INTEGER, paid INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE service_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_service_usage ON service_usage(service, ts);
  `);
  legacy.exec(`
    INSERT INTO jobs (name, description, schedule, enabled) VALUES ('resolve', 'r', '0 3 * * *', 1);
    INSERT INTO workflows (name, schedule) VALUES ('places', '0 3 * * *');
    INSERT INTO workflow_jobs (workflow_name, job_name) VALUES ('places', 'resolve');
    INSERT INTO runs (id, job_name, status, trigger) VALUES ('run-1', 'resolve', 'success', 'manual');
    INSERT INTO workflow_runs (id, workflow_name, status, trigger) VALUES ('wr-1', 'places', 'success', 'manual');
    -- Pre-T151 TV-season workflow under its old 'plex' slug, with member links + run
    -- history — the migration must rename it to 'missing-tv-seasons' preserving these.
    INSERT INTO jobs (name, description) VALUES ('plex-tv-snapshot', 's');
    INSERT INTO workflows (name, schedule) VALUES ('plex', '0 9 * * 1');
    INSERT INTO workflow_jobs (workflow_name, job_name) VALUES ('plex', 'plex-tv-snapshot');
    INSERT INTO workflow_runs (id, workflow_name, status, trigger) VALUES ('wr-plex-1', 'plex', 'success', 'scheduled');
    -- Pre-T168 movies workflow under its old 'movies' slug, with member links + run
    -- history — the migration must rename it to 'movie-recommendations' preserving these.
    INSERT INTO jobs (name, description) VALUES ('movie-snapshot', 's');
    INSERT INTO workflows (name, schedule) VALUES ('movies', '0 9 1 * *');
    INSERT INTO workflow_jobs (workflow_name, job_name) VALUES ('movies', 'movie-snapshot');
    INSERT INTO workflow_runs (id, workflow_name, status, trigger) VALUES ('wr-movies-1', 'movies', 'success', 'scheduled');
    INSERT INTO work_items (job_name, item_key, status, attempts) VALUES
      ('resolve', 'cid-1', 'success', 1),
      ('resolve', 'cid-2', 'failed', 2),
      ('resolve', 'cid-3', 'dismissed', 3);   -- legacy manual-park status (T033 → 'ignored')
    INSERT INTO services (name, paid) VALUES ('google-places', 1);
  `);
  legacy.close();
}

// ── Run the REAL openDb() against the pre-seeded legacy file. ──
// Pre-fix, schema.sql's `CREATE INDEX idx_work_items_root ON work_items(root_key)`
// runs against the legacy work_items (no root_key yet) and THIS call throws.
let migrated: Database.Database;
test('openDb() does NOT throw against an existing old-shape DB (the T094 crash-loop)', () => {
  migrated = openDb(dbPath);
});

const cols = (t: string): string[] =>
  (migrated.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
const hasIndex = (name: string): boolean =>
  !!migrated.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?").get(name);

test('work_items ends migrated: root_key + parent_key columns + idx_work_items_root index', () => {
  assert.ok(cols('work_items').includes('root_key'), 'root_key column added');
  assert.ok(cols('work_items').includes('parent_key'), 'parent_key column added');
  assert.ok(hasIndex('idx_work_items_root'), 'idx_work_items_root index created (in the migration, after the ALTER)');
});

test('legacy work_items rows are backfilled root_key = item_key (each its own root)', () => {
  const rows = migrated
    .prepare('SELECT item_key, root_key, parent_key FROM work_items ORDER BY item_key')
    .all() as { item_key: string; root_key: string; parent_key: string | null }[];
  assert.deepEqual(rows, [
    { item_key: 'cid-1', root_key: 'cid-1', parent_key: null },
    { item_key: 'cid-2', root_key: 'cid-2', parent_key: null },
    { item_key: 'cid-3', root_key: 'cid-3', parent_key: null },
  ]);
});

test('runs ends migrated: workflow_run_id column + idx_runs_workflow index', () => {
  assert.ok(cols('runs').includes('workflow_run_id'), 'workflow_run_id column added');
  assert.ok(hasIndex('idx_runs_workflow'), 'idx_runs_workflow index created');
});

test('workflow_runs ends migrated: run_limit + selected_roots (NULL = unlimited)', () => {
  assert.ok(cols('workflow_runs').includes('run_limit'), 'run_limit column added');
  assert.ok(cols('workflow_runs').includes('selected_roots'), 'selected_roots column added');
  const r = migrated.prepare('SELECT run_limit, selected_roots FROM workflow_runs WHERE id = ?').get('wr-1') as {
    run_limit: number | null; selected_roots: string | null;
  };
  assert.equal(r.run_limit, null, 'pre-existing run defaults to unlimited');
  assert.equal(r.selected_roots, null);
});

test('services ends migrated: limits_overridden column (defaults 0 = code-owned)', () => {
  assert.ok(cols('services').includes('limits_overridden'), 'limits_overridden column added');
  const s = migrated.prepare('SELECT limits_overridden FROM services WHERE name = ?').get('google-places') as {
    limits_overridden: number;
  };
  assert.equal(s.limits_overridden, 0);
});

test('workflows ends migrated: schedule_overridden column (defaults 0 = code-owned) (T135)', () => {
  assert.ok(cols('workflows').includes('schedule_overridden'), 'schedule_overridden column added');
  const w = migrated.prepare('SELECT schedule_overridden FROM workflows WHERE name = ?').get('places') as {
    schedule_overridden: number;
  };
  assert.equal(w.schedule_overridden, 0, 'pre-existing workflow defaults to NOT overridden');
});

test('workflows ends migrated: max_concurrency columns added (defaults NULL / 0) (T169)', () => {
  assert.ok(cols('workflows').includes('max_concurrency'), 'max_concurrency column added');
  assert.ok(cols('workflows').includes('max_concurrency_overridden'), 'max_concurrency_overridden column added');
  const w = migrated.prepare('SELECT max_concurrency, max_concurrency_overridden FROM workflows WHERE name = ?').get('places') as {
    max_concurrency: number | null;
    max_concurrency_overridden: number;
  };
  assert.equal(w.max_concurrency, null, 'pre-existing workflow has NULL max_concurrency (use code default)');
  assert.equal(w.max_concurrency_overridden, 0, 'pre-existing workflow defaults to NOT overridden');
});

test('workflows ends migrated: notify_enabled columns added (defaults 1 / 0) (T285)', () => {
  assert.ok(cols('workflows').includes('notify_enabled'), 'notify_enabled column added');
  assert.ok(cols('workflows').includes('notify_enabled_overridden'), 'notify_enabled_overridden column added');
  const w = migrated.prepare('SELECT notify_enabled, notify_enabled_overridden FROM workflows WHERE name = ?').get('places') as {
    notify_enabled: number;
    notify_enabled_overridden: number;
  };
  assert.equal(w.notify_enabled, 1, 'pre-existing workflow defaults to notify_enabled ON');
  assert.equal(w.notify_enabled_overridden, 0, 'pre-existing workflow defaults to NOT overridden');
});

test("workflows ends migrated: category column added (defaults '') (T292)", () => {
  assert.ok(cols('workflows').includes('category'), 'category column added');
  const w = migrated.prepare('SELECT category FROM workflows WHERE name = ?').get('places') as { category: string };
  assert.equal(w.category, '', 'pre-existing workflow defaults to empty category (re-synced to manifest value at daemon start)');
});

test("services ends migrated: rate_limit_source column added (defaults '') (T449)", () => {
  assert.ok(cols('services').includes('rate_limit_source'), 'rate_limit_source column added');
  const s = migrated.prepare('SELECT rate_limit_source FROM services WHERE name = ?').get('google-places') as {
    rate_limit_source: string;
  };
  assert.equal(
    s.rate_limit_source,
    '',
    'pre-existing service defaults to empty rate_limit_source (re-synced to manifest value at daemon start)',
  );
});

test('services ends migrated: timeout_ms column added (defaults NULL = no override) (T465)', () => {
  assert.ok(cols('services').includes('timeout_ms'), 'timeout_ms column added');
  const s = migrated.prepare('SELECT timeout_ms FROM services WHERE name = ?').get('google-places') as {
    timeout_ms: number | null;
  };
  assert.equal(s.timeout_ms, null, 'pre-existing service defaults to a null timeout_ms (no override yet)');
});

test('jobs ends migrated: legacy schedule + enabled columns dropped (T070)', () => {
  assert.ok(!cols('jobs').includes('schedule'), 'schedule column dropped');
  assert.ok(!cols('jobs').includes('enabled'), 'enabled column dropped');
});

test('jobs ends migrated: timeout_ms_overridden column added (defaults 0 = code-owned) (T297)', () => {
  assert.ok(cols('jobs').includes('timeout_ms_overridden'), 'timeout_ms_overridden column added');
  const j = migrated.prepare('SELECT timeout_ms_overridden FROM jobs WHERE name = ?').get('resolve') as {
    timeout_ms_overridden: number;
  };
  assert.equal(j.timeout_ms_overridden, 0, 'pre-existing job defaults to NOT overridden');
});

test('services/workflows/jobs end migrated: every "_overridden_at" timestamp column added, defaults NULL (T475)', () => {
  assert.ok(cols('services').includes('limits_overridden_at'), 'limits_overridden_at column added');
  assert.ok(cols('workflows').includes('schedule_overridden_at'), 'schedule_overridden_at column added');
  assert.ok(cols('workflows').includes('max_concurrency_overridden_at'), 'max_concurrency_overridden_at column added');
  assert.ok(cols('workflows').includes('notify_enabled_overridden_at'), 'notify_enabled_overridden_at column added');
  assert.ok(cols('jobs').includes('timeout_ms_overridden_at'), 'timeout_ms_overridden_at column added');
  const s = migrated.prepare('SELECT limits_overridden_at FROM services WHERE name = ?').get('google-places') as { limits_overridden_at: string | null };
  assert.equal(s.limits_overridden_at, null, 'pre-existing overridden service has NULL timestamp — unknown age, always report');
  const w = migrated.prepare('SELECT schedule_overridden_at, max_concurrency_overridden_at, notify_enabled_overridden_at FROM workflows WHERE name = ?').get('places') as {
    schedule_overridden_at: string | null; max_concurrency_overridden_at: string | null; notify_enabled_overridden_at: string | null;
  };
  assert.equal(w.schedule_overridden_at, null);
  assert.equal(w.max_concurrency_overridden_at, null);
  assert.equal(w.notify_enabled_overridden_at, null);
  const j = migrated.prepare('SELECT timeout_ms_overridden_at FROM jobs WHERE name = ?').get('resolve') as { timeout_ms_overridden_at: string | null };
  assert.equal(j.timeout_ms_overridden_at, null);
});

test("legacy 'dismissed' work_item is migrated to 'ignored' (T033)", () => {
  const r = migrated.prepare('SELECT status FROM work_items WHERE item_key = ?').get('cid-3') as { status: string };
  assert.equal(r.status, 'ignored');
  const dismissed = migrated.prepare("SELECT COUNT(*) c FROM work_items WHERE status = 'dismissed'").get() as { c: number };
  assert.equal(dismissed.c, 0, 'no dismissed rows remain');
});

test('plex workflow is renamed to missing-tv-seasons, run history + member links preserved (T151)', () => {
  // The old `plex` workflow + job-link + run rows must carry over under the new name.
  assert.equal(
    (migrated.prepare("SELECT COUNT(*) c FROM workflows WHERE name = 'plex'").get() as { c: number }).c,
    0,
    'no orphaned `plex` workflow row lingers',
  );
  assert.equal(
    (migrated.prepare("SELECT COUNT(*) c FROM workflows WHERE name = 'missing-tv-seasons'").get() as { c: number }).c,
    1,
    'workflow renamed to missing-tv-seasons',
  );
  const job = migrated
    .prepare("SELECT job_name FROM workflow_jobs WHERE workflow_name = 'missing-tv-seasons'")
    .get() as { job_name: string } | undefined;
  assert.equal(job?.job_name, 'plex-tv-snapshot', 'member job link carried over (job name unchanged)');
  const run = migrated
    .prepare("SELECT workflow_name, status FROM workflow_runs WHERE id = 'wr-plex-1'")
    .get() as { workflow_name: string; status: string } | undefined;
  assert.equal(run?.workflow_name, 'missing-tv-seasons', 'historical run re-pointed to the new name');
  assert.equal(run?.status, 'success', 'historical run status preserved');
});

test('movies workflow is renamed to movie-recommendations, run history + member links preserved (T168)', () => {
  assert.equal(
    (migrated.prepare("SELECT COUNT(*) c FROM workflows WHERE name = 'movies'").get() as { c: number }).c,
    0,
    'no orphaned `movies` workflow row lingers',
  );
  assert.equal(
    (migrated.prepare("SELECT COUNT(*) c FROM workflows WHERE name = 'movie-recommendations'").get() as { c: number }).c,
    1,
    'workflow renamed to movie-recommendations',
  );
  const job = migrated
    .prepare("SELECT job_name FROM workflow_jobs WHERE workflow_name = 'movie-recommendations'")
    .get() as { job_name: string } | undefined;
  assert.equal(job?.job_name, 'movie-snapshot', 'member job link carried over (job name unchanged)');
  const run = migrated
    .prepare("SELECT workflow_name, status FROM workflow_runs WHERE id = 'wr-movies-1'")
    .get() as { workflow_name: string; status: string } | undefined;
  assert.equal(run?.workflow_name, 'movie-recommendations', 'historical run re-pointed to the new name');
  assert.equal(run?.status, 'success', 'historical run status preserved');
});

test('all seeded rows are preserved (no data loss across the bootstrap+migration)', () => {
  assert.equal((migrated.prepare('SELECT COUNT(*) c FROM work_items').get() as { c: number }).c, 3);
  assert.equal((migrated.prepare('SELECT COUNT(*) c FROM runs').get() as { c: number }).c, 1);
  assert.equal((migrated.prepare('SELECT COUNT(*) c FROM workflow_runs').get() as { c: number }).c, 3);
  assert.equal((migrated.prepare('SELECT COUNT(*) c FROM workflows').get() as { c: number }).c, 3);
});

test('idempotent: a SECOND openDb() against the now-migrated file is a clean no-op', () => {
  migrated.close();
  const again = openDb(dbPath);
  assert.equal((again.prepare('SELECT COUNT(*) c FROM work_items').get() as { c: number }).c, 3);
  assert.ok(
    (again.prepare('PRAGMA table_info(work_items)').all() as { name: string }[]).some((c) => c.name === 'root_key'),
  );
  again.close();
});

for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
console.log(`\n${passed} existing-db migration test(s) passed.`);
