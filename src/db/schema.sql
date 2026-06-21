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
  pipeline_run_id TEXT,                    -- set when this run is a pipeline member
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
-- job's natural unit of work (place_id for the places pipeline).
CREATE TABLE IF NOT EXISTS work_items (
  job_name   TEXT NOT NULL,
  item_key   TEXT NOT NULL,
  status     TEXT NOT NULL,             -- success | failed | skipped | dismissed (manual park: stuck item given up on)
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

-- ─────────────────────── Pipelines (a DAG of jobs) ───────────────────────
-- A pipeline composes existing jobs into a DAG the framework runs as one unit.
-- `enabled` is user-owned (dashboard toggle), preserved across code syncs.
CREATE TABLE IF NOT EXISTS pipelines (
  name        TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  schedule    TEXT,                       -- cron, or NULL for manual-only
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Membership + edges, synced (replaced) from each *.pipeline.ts manifest.
CREATE TABLE IF NOT EXISTS pipeline_jobs (
  pipeline_name TEXT NOT NULL,
  job_name      TEXT NOT NULL,
  depends_on    TEXT NOT NULL DEFAULT '[]', -- JSON array of member job names
  PRIMARY KEY (pipeline_name, job_name),
  FOREIGN KEY (pipeline_name) REFERENCES pipelines(name)
);

-- One row per pipeline execution.
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id            TEXT PRIMARY KEY,
  pipeline_name TEXT NOT NULL,
  status        TEXT NOT NULL,             -- running | success | partial | failed | cancelled
  trigger       TEXT NOT NULL,             -- schedule | manual
  progress      INTEGER NOT NULL DEFAULT 0,
  progress_msg  TEXT NOT NULL DEFAULT '',
  started_at    TEXT,
  finished_at   TEXT,
  duration_ms   INTEGER,
  FOREIGN KEY (pipeline_name) REFERENCES pipelines(name)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_name ON pipeline_runs(pipeline_name, started_at DESC);

-- Framework-level log lines for a pipeline run (orchestration events: stage
-- start/finish, notifications sent/failed, throttle/quota waits, skips). Distinct
-- from each member job's own run_logs.
CREATE TABLE IF NOT EXISTS pipeline_run_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_run_id TEXT NOT NULL,
  ts              TEXT NOT NULL DEFAULT (datetime('now')),
  level           TEXT NOT NULL DEFAULT 'info',
  message         TEXT NOT NULL,
  FOREIGN KEY (pipeline_run_id) REFERENCES pipeline_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_run_logs ON pipeline_run_logs(pipeline_run_id, id);

-- ─────────────────── Services (shared rate limits + quotas) ───────────────────
-- An external dependency whose limits are enforced ACROSS all jobs — a per-job
-- cap can't protect an API called from several jobs.
CREATE TABLE IF NOT EXISTS services (
  name            TEXT PRIMARY KEY,
  description     TEXT NOT NULL DEFAULT '',
  rate_per_minute INTEGER,                 -- NULL = no throttle
  daily_cap       INTEGER,                 -- NULL = no daily quota
  monthly_cap     INTEGER,                 -- NULL = no monthly quota
  paid            INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per service call (incl. retries); rate/quota enforced by counting rows
-- in the trailing window. Generalises the per-job job_usage meter.
CREATE TABLE IF NOT EXISTS service_usage (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  ts      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_service_usage ON service_usage(service, ts);
