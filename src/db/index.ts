import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Open (or create) the SQLite database and apply the schema + migrations.
 * WAL mode lets the daemon write while the dashboard reads concurrently.
 *
 * `dbPath` defaults to the configured DB; it's parameterised ONLY so the
 * regression suite can drive the full bootstrap+migration path against a
 * pre-seeded old-shape database (see migrate-existing-db.test.ts) — the daemon
 * always uses the default.
 */
export function openDb(dbPath: string = config.dbPath): Database.Database {
  const db = new Database(dbPath);
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

  // Additive migration: user-owned schedule override flag on workflows (T135).
  // Like `limits_overridden` on services, this lets a dashboard edit take ownership
  // of the cron `schedule` so a later code-sync preserves it (see upsertWorkflowStmt).
  const wfCols = db.prepare('PRAGMA table_info(workflows)').all() as { name: string }[];
  if (!wfCols.some((c) => c.name === 'schedule_overridden')) {
    db.exec('ALTER TABLE workflows ADD COLUMN schedule_overridden INTEGER NOT NULL DEFAULT 0');
  }

  migrateDropJobColumns(db);
  migrateRunLimitLineage(db);
  migrateRenamePlexWorkflow(db);

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

/**
 * Additive, idempotent migration (T094) for the manual run-limit feature:
 *  - `work_items.root_key` / `parent_key` — input lineage so a limit can bound N
 *    originating inputs and run ALL their fan-out. Existing rows are backfilled to
 *    `root_key = item_key` (each is its own root) + an index on (job_name, root_key).
 *  - `workflow_runs.run_limit` / `selected_roots` — the per-run cap + frozen
 *    allowlist (both NULL = unlimited; scheduled runs never set them).
 * Safe on a fresh DB (schema.sql already has the columns → the guards skip).
 */
export function migrateRunLimitLineage(db: Database.Database): void {
  const tableExists = (name: string): boolean =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);

  if (tableExists('work_items')) {
    const wiCols = db.prepare('PRAGMA table_info(work_items)').all() as { name: string }[];
    if (!wiCols.some((c) => c.name === 'root_key')) db.exec('ALTER TABLE work_items ADD COLUMN root_key TEXT');
    if (!wiCols.some((c) => c.name === 'parent_key')) db.exec('ALTER TABLE work_items ADD COLUMN parent_key TEXT');
    db.exec('UPDATE work_items SET root_key = item_key WHERE root_key IS NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_root ON work_items(job_name, root_key)');
  }

  if (tableExists('workflow_runs')) {
    const wrCols = db.prepare('PRAGMA table_info(workflow_runs)').all() as { name: string }[];
    if (!wrCols.some((c) => c.name === 'run_limit')) db.exec('ALTER TABLE workflow_runs ADD COLUMN run_limit INTEGER');
    if (!wrCols.some((c) => c.name === 'selected_roots')) db.exec('ALTER TABLE workflow_runs ADD COLUMN selected_roots TEXT');
  }
}

/**
 * Idempotent rename (T151) of the TV-season workflow from the un-intuitive `plex`
 * slug to the descriptive `missing-tv-seasons`. The workflow `name` is the id, the
 * URL slug, AND the DB key, so renaming only the manifest would orphan the old
 * `plex` workflow row + its historical runs under a now-manifest-less name. This
 * carries them over: rename the `workflows` row plus the `workflow_jobs` /
 * `workflow_runs` rows that reference it. Member JOB names are unchanged (their
 * `work_items` are keyed by job name), so `workflow_jobs.job_name` is untouched.
 *
 * Guarded on the old `plex` row existing, so it's a no-op once migrated (and on a
 * fresh DB the new name is synced from the manifest directly). Runs with
 * `foreign_keys = ON`; updating the parent `workflows.name` first would orphan the
 * children mid-statement, so we update the child references first, then the parent.
 */
export function migrateRenamePlexWorkflow(db: Database.Database): void {
  const tableExists = (name: string): boolean =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  if (!tableExists('workflows')) return; // fresh DB before schema bootstrap — never happens here
  const hasOld = !!db.prepare("SELECT 1 FROM workflows WHERE name = 'plex'").get();
  if (!hasOld) return; // already migrated, or never existed

  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  // Defer FK enforcement so we can rewrite the parent + children atomically without
  // a transient orphan tripping the constraint. PRAGMA foreign_keys is a no-op
  // inside a transaction, so toggle it OUTSIDE one, then wrap the updates.
  if (fkWasOn) db.pragma('foreign_keys = OFF');
  try {
    const rename = db.transaction(() => {
      if (tableExists('workflow_jobs')) {
        db.prepare("UPDATE workflow_jobs SET workflow_name = 'missing-tv-seasons' WHERE workflow_name = 'plex'").run();
      }
      if (tableExists('workflow_runs')) {
        db.prepare("UPDATE workflow_runs SET workflow_name = 'missing-tv-seasons' WHERE workflow_name = 'plex'").run();
      }
      db.prepare("UPDATE workflows SET name = 'missing-tv-seasons' WHERE name = 'plex'").run();
    });
    rename();
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
}

// Single shared connection for the process that imports this module.
export const db = openDb();
