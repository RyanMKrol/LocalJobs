-- Job definitions, synced from code on daemon startup.
-- `enabled` is owned by the user (toggled from the dashboard) and preserved across syncs.
CREATE TABLE IF NOT EXISTS jobs (
  name         TEXT PRIMARY KEY,
  description  TEXT NOT NULL DEFAULT '',
  schedule     TEXT,                      -- cron expression, or NULL for manual-only
  timeout_ms   INTEGER NOT NULL DEFAULT 0, -- 0 = no timeout
  max_retries  INTEGER NOT NULL DEFAULT 0,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per execution attempt.
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  job_name     TEXT NOT NULL,
  status       TEXT NOT NULL,             -- queued | running | success | failed | timeout | cancelled
  trigger      TEXT NOT NULL,             -- schedule | manual
  attempt      INTEGER NOT NULL DEFAULT 1,
  progress     INTEGER NOT NULL DEFAULT 0, -- 0..100
  progress_msg TEXT NOT NULL DEFAULT '',
  started_at   TEXT,
  finished_at  TEXT,
  duration_ms  INTEGER,
  exit_code    INTEGER,
  error        TEXT,
  workflow_run_id TEXT,                    -- set when this run is a workflow member
  FOREIGN KEY (job_name) REFERENCES jobs(name)
);

CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

-- Streamed log lines per run.
CREATE TABLE IF NOT EXISTS run_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL,
  ts      TEXT NOT NULL DEFAULT (datetime('now')),
  level   TEXT NOT NULL DEFAULT 'info',   -- info | warn | error
  message TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE INDEX IF NOT EXISTS idx_logs_run ON run_logs(run_id, id);

-- Per-item idempotency ledger. A "work item" is one unit of work a job processes
-- (e.g. one place_id). Jobs record an outcome here so they never reprocess an
-- item that's already done. Keyed by (job_name, item_key) — the item_key is the
-- job's natural unit of work (place_id for the places workflow).
CREATE TABLE IF NOT EXISTS work_items (
  job_name   TEXT NOT NULL,
  item_key   TEXT NOT NULL,
  status     TEXT NOT NULL,             -- success | failed | skipped | ignored (manual park: stuck item given up on; the ONE manual-park concept)
  attempts   INTEGER NOT NULL DEFAULT 1,
  detail     TEXT,                      -- optional JSON: error, output path, summary…
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_name, item_key)
);

CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(job_name, status);

-- Spend/usage meter. One row per metered external action (e.g. one API call), so a
-- job can enforce per-day and per-month caps by counting rows in the window. This
-- counts ACTIONS (incl. retries), distinct from work_items which tracks items.
CREATE TABLE IF NOT EXISTS job_usage (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  ts       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_usage ON job_usage(job_name, ts);

-- ─────────────────────── Workflows (a DAG of jobs) ───────────────────────
-- A workflow composes existing jobs into a DAG the framework runs as one unit.
-- `enabled` is user-owned (dashboard toggle), preserved across code syncs.
CREATE TABLE IF NOT EXISTS workflows (
  name        TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  schedule    TEXT,                       -- cron, or NULL for manual-only
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Membership + edges, synced (replaced) from each *.workflow.ts manifest.
CREATE TABLE IF NOT EXISTS workflow_jobs (
  workflow_name TEXT NOT NULL,
  job_name      TEXT NOT NULL,
  depends_on    TEXT NOT NULL DEFAULT '[]', -- JSON array of member job names
  PRIMARY KEY (workflow_name, job_name),
  FOREIGN KEY (workflow_name) REFERENCES workflows(name)
);

-- One row per workflow execution.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id            TEXT PRIMARY KEY,
  workflow_name TEXT NOT NULL,
  status        TEXT NOT NULL,             -- running | success | partial | failed | cancelled
  trigger       TEXT NOT NULL,             -- schedule | manual
  progress      INTEGER NOT NULL DEFAULT 0,
  progress_msg  TEXT NOT NULL DEFAULT '',
  started_at    TEXT,
  finished_at   TEXT,
  duration_ms   INTEGER,
  FOREIGN KEY (workflow_name) REFERENCES workflows(name)
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_name ON workflow_runs(workflow_name, started_at DESC);

-- Framework-level log lines for a workflow run (orchestration events: stage
-- start/finish, notifications sent/failed, throttle/quota waits, skips). Distinct
-- from each member job's own run_logs.
CREATE TABLE IF NOT EXISTS workflow_run_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_run_id TEXT NOT NULL,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  level           TEXT NOT NULL DEFAULT 'info',
  message         TEXT NOT NULL,
  FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_logs ON workflow_run_logs(workflow_run_id, id);

-- ─────────────────── Services (shared rate limits + quotas) ───────────────────
-- An external dependency whose limits are enforced ACROSS all jobs — a per-job
-- cap can't protect an API called from several jobs.
-- The limit columns (rate_per_minute/daily_cap/monthly_cap) are seeded from code
-- on sync, but a dashboard edit takes ownership: `limits_overridden` flips to 1
-- and a subsequent code-sync then PRESERVES the user's values (same reconcile as
-- the user-owned `enabled` flag on jobs/workflows).
CREATE TABLE IF NOT EXISTS services (
  name              TEXT PRIMARY KEY,
  description       TEXT NOT NULL DEFAULT '',
  rate_per_minute   INTEGER,                 -- NULL = no throttle
  daily_cap         INTEGER,                 -- NULL = no daily quota
  monthly_cap       INTEGER,                 -- NULL = no monthly quota
  paid              INTEGER NOT NULL DEFAULT 0,
  limits_overridden INTEGER NOT NULL DEFAULT 0, -- 1 = user edited limits; code-sync preserves them
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per service call (incl. retries); rate/quota enforced by counting rows
-- in the trailing window. Generalises the per-job job_usage meter.
CREATE TABLE IF NOT EXISTS service_usage (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  ts      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_service_usage ON service_usage(service, ts);
