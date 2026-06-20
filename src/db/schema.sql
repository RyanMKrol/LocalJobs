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
  status     TEXT NOT NULL,             -- success | failed | skipped
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
