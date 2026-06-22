import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Open (or create) the SQLite database and apply the schema.
 * WAL mode lets the daemon write while the dashboard reads concurrently.
 */
export function openDb(): Database.Database {
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Rename migration (T038): the "pipeline" concept was renamed to "workflow".
  // Move any legacy pipeline_* tables/columns to their workflow_* names BEFORE the
  // schema bootstrap below — otherwise `CREATE TABLE IF NOT EXISTS workflow_*`
  // would create EMPTY tables alongside the populated legacy ones and lose data.
  migrateWorkflowRename(db);

  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Additive column migration: CREATE TABLE IF NOT EXISTS won't add a new column
  // to an already-existing `runs` table, so add it idempotently here.
  const runCols = db.prepare('PRAGMA table_info(runs)').all() as { name: string }[];
  if (!runCols.some((c) => c.name === 'workflow_run_id')) {
    db.exec('ALTER TABLE runs ADD COLUMN workflow_run_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_workflow ON runs(workflow_run_id)');

  // Additive migration: user-owned limit override flag on services (T018).
  const svcCols = db.prepare('PRAGMA table_info(services)').all() as { name: string }[];
  if (!svcCols.some((c) => c.name === 'limits_overridden')) {
    db.exec('ALTER TABLE services ADD COLUMN limits_overridden INTEGER NOT NULL DEFAULT 0');
  }

  migrateDropJobColumns(db);

  // Data migration: unify the manual-park concept on a single name (T033).
  // The old `dismissed` status is renamed to `ignored` — same semantics
  // (parked, never reprocessed, off the stuck list). Idempotent.
  db.exec("UPDATE work_items SET status = 'ignored' WHERE status = 'dismissed'");

  return db;
}

/**
 * One-time, idempotent rename of legacy `pipeline_*` schema objects to `workflow_*`
 * (T038). Renames preserve all existing rows. A brand-new DB has no `pipeline_*`
 * objects (every step is skipped), and a DB already migrated has the `workflow_*`
 * names (also skipped). Runs with `foreign_keys = ON`, so SQLite rewrites the FK
 * references in child tables automatically as each table/column is renamed.
 */
export function migrateWorkflowRename(db: Database.Database): void {
  const tableExists = (name: string): boolean =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  const columnExists = (table: string, col: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
      (c) => c.name === col,
    );

  const tableRenames: [string, string][] = [
    ['pipelines', 'workflows'],
    ['pipeline_jobs', 'workflow_jobs'],
    ['pipeline_runs', 'workflow_runs'],
    ['pipeline_run_logs', 'workflow_run_logs'],
  ];
  for (const [from, to] of tableRenames) {
    if (tableExists(from) && !tableExists(to)) db.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
  }

  // Rename the pipeline_* columns inside the renamed tables, plus the member-link
  // column on `runs`.
  const columnRenames: [string, string, string][] = [
    ['workflow_jobs', 'pipeline_name', 'workflow_name'],
    ['workflow_runs', 'pipeline_name', 'workflow_name'],
    ['workflow_run_logs', 'pipeline_run_id', 'workflow_run_id'],
    ['runs', 'pipeline_run_id', 'workflow_run_id'],
  ];
  for (const [table, from, to] of columnRenames) {
    if (tableExists(table) && columnExists(table, from) && !columnExists(table, to)) {
      db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
    }
  }

  // Legacy indexes survive a table rename under their old names; drop them so the
  // schema below recreates them with the workflow_* names (no duplicate indexes).
  for (const idx of ['idx_pipeline_runs_name', 'idx_pipeline_run_logs', 'idx_runs_pipeline']) {
    db.exec(`DROP INDEX IF EXISTS ${idx}`);
  }
}

/**
 * Destructive column migration (T070): a job is only ever a workflow member, so
 * workflow-level concerns must NOT live on individual jobs. Drop the now-unused
 * per-job `schedule` and `enabled` columns from an already-existing `jobs` table
 * (a fresh DB never had them — see schema.sql). Neither column is indexed, so the
 * DROP is safe; idempotent (skipped once the column is gone). No meaningful data
 * loss: scheduling + the enable toggle live on the `workflows` table.
 */
export function migrateDropJobColumns(db: Database.Database): void {
  const tableExists = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = 'jobs'")
    .get();
  if (!tableExists) return; // fresh DB: schema.sql will create the trimmed table
  const cols = (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name);
  if (cols.includes('schedule')) db.exec('ALTER TABLE jobs DROP COLUMN schedule');
  if (cols.includes('enabled')) db.exec('ALTER TABLE jobs DROP COLUMN enabled');
}

// Single shared connection for the process that imports this module.
export const db = openDb();
