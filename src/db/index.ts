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
  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Additive column migration: CREATE TABLE IF NOT EXISTS won't add a new column
  // to an already-existing `runs` table, so add it idempotently here.
  const runCols = db.prepare('PRAGMA table_info(runs)').all() as { name: string }[];
  if (!runCols.some((c) => c.name === 'pipeline_run_id')) {
    db.exec('ALTER TABLE runs ADD COLUMN pipeline_run_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_pipeline ON runs(pipeline_run_id)');

  return db;
}

// Single shared connection for the process that imports this module.
export const db = openDb();
