-- Job definitions, synced from code on daemon startup.
-- A job is ONLY ever a workflow member (T037/T070): workflow-level concerns —
-- schedule + the enable toggle — live on the `workflows` table, never here. A job
-- carries no `schedule` or `enabled` column; you run a workflow, never a job.
CREATE TABLE IF NOT EXISTS jobs (
  name         TEXT PRIMARY KEY,
  description  TEXT NOT NULL DEFAULT '',
  timeout_ms   INTEGER NOT NULL DEFAULT 0, -- 0 = no timeout
  timeout_ms_overridden INTEGER NOT NULL DEFAULT 0, -- user-editable override (T297), mirrors workflow schedule/maxConcurrency overrides
  timeout_ms_overridden_at TEXT, -- when the override was set (T475); NULL = never overridden, or overridden before this column existed
  max_retries  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per execution attempt.
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  job_name     TEXT NOT NULL,
  status       TEXT NOT NULL,             -- queued | running | success | failed | timeout | cancelled | skipped
  trigger      TEXT NOT NULL,             -- schedule | manual | workflow
  attempt      INTEGER NOT NULL DEFAULT 1,
  progress     INTEGER NOT NULL DEFAULT 0, -- 0..100
  progress_msg TEXT NOT NULL DEFAULT '',
  started_at   TEXT,
  finished_at  TEXT,
  duration_ms  INTEGER,
  exit_code    INTEGER,
  error        TEXT,
  workflow_run_id TEXT,                    -- set when this run is a workflow member
  -- Engine v2 (added to existing DBs by migrateEngineV2 in index.ts; NO index on
  -- any of these here, per the T098 rule):
  cycle          INTEGER,                  -- repeatUntilStable cycle this run belongs to (1-based); NULL = pre-v2 run
  outcome_reason TEXT,                     -- WHY a non-success/skipped row ended as it did: noop | stalled | upstream-skipped | overlap | gate-failed | not-started-cancelled | orphaned
  queued_at_ms   INTEGER,                  -- epoch ms the stage became ready (all deps settled)
  started_at_ms  INTEGER,                  -- epoch ms this attempt's process was spawned
  finished_at_ms INTEGER,                  -- epoch ms this attempt settled
  gate_ms        INTEGER,                  -- time spent checking inbound gates/inputs before spawn
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
CREATE INDEX IF NOT EXISTS idx_run_logs_ts ON run_logs(ts, id);

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
  -- Input lineage (T094): the ORIGINATING input this item descends from. For a
  -- root item root_key == item_key; downstream/fan-out stages inherit it via
  -- parent_key so a manual run-limit can bound the set of originating inputs and
  -- run ALL their fan-out. NULL only on rows from before the migration (backfilled
  -- to item_key) — markWorkItem always resolves a root.
  root_key   TEXT,                      -- originating input this item descends from
  parent_key TEXT,                      -- immediate upstream item (for fan-out); NULL for roots
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_name, item_key)
);

CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(job_name, status);

-- Run→work-item attribution (T139). work_items above is a CUMULATIVE, idempotent
-- ledger keyed by (job_name, item_key) with NO run linkage — so the run-page
-- Input→Output panel could only ever dump the GLOBAL ledger, not the items a
-- specific run advanced. This append-only table records WHICH workflow run advanced
-- each work item: markWorkItem inserts a row whenever it runs inside a workflow run
-- (LOCALJOBS_WORKFLOW_RUN_ID present in the child's env), using the SAME resolved
-- root_key. A standalone (non-workflow) run records nothing. Unlike the work_items
-- root_key index (which an additive migration adds — the T098 trap), this is a
-- BRAND-NEW table whose columns exist on creation for BOTH fresh and existing DBs,
-- so its index may safely live here in the schema bootstrap.
CREATE TABLE IF NOT EXISTS work_item_runs (
  workflow_run_id TEXT NOT NULL,
  job_name        TEXT NOT NULL,
  item_key        TEXT NOT NULL,
  root_key        TEXT,
  at              TEXT NOT NULL DEFAULT (datetime('now')),
  -- Engine v2 per-run SNAPSHOT (added to existing DBs by migrateEngineV2; its
  -- run_id index is created in that migration, NOT here, per the T098 rule).
  -- work_items is an upsert, so on its own it only ever knows an item's CURRENT
  -- state. These columns freeze what THIS run recorded, so an old run's page
  -- shows what that run did rather than today's state.
  run_id          TEXT,                    -- the member run (stage attempt) that wrote this row
  cycle           INTEGER,
  status          TEXT,                    -- the status this run recorded
  attempts        INTEGER,
  detail          TEXT,                    -- the detail JSON this run recorded (capped)
  title           TEXT,                    -- display title, when the writer supplied one
  input_job       TEXT,                    -- upstream ledger job this item was read from
  input_key       TEXT,                    -- upstream item key (defaults to item_key)
  at_ms           INTEGER,
  UNIQUE(workflow_run_id, job_name, item_key)
);
CREATE INDEX IF NOT EXISTS idx_work_item_runs_run ON work_item_runs(workflow_run_id);

-- NOTE: the (job_name, root_key) index is created by migrateRunLimitLineage() in
-- index.ts, NOT here. On an already-existing DB the root_key column is added by
-- that migration, which runs AFTER this schema bootstrap; creating the index here
-- would reference a column that doesn't exist yet and crash openDb on every start
-- (the T094 regression). Keep it in the migration so both fresh and existing DBs work.

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
-- `enabled` is user-owned (dashboard toggle), preserved across code syncs. The
-- `schedule` is likewise user-editable from the dashboard (T135): once edited,
-- `schedule_overridden` flips to 1 and a code-sync PRESERVES the user's value —
-- the same reconcile `enabled` and the service limits get. `max_concurrency` is
-- the same shape (T169): the manifest's maxConcurrency seeds it on sync, a
-- dashboard edit flips `max_concurrency_overridden` and code-sync preserves it.
-- `notify_enabled` is the same shape again (T285): the manifest's notifyEnabled
-- (default true) seeds it on sync, a dashboard toggle flips
-- `notify_enabled_overridden` and code-sync preserves it.
CREATE TABLE IF NOT EXISTS workflows (
  name                    TEXT PRIMARY KEY,
  description             TEXT NOT NULL DEFAULT '',
  category                TEXT NOT NULL DEFAULT '',  -- manifest-owned grouping label; always refreshed from code on sync
  idempotency_note        TEXT NOT NULL DEFAULT '',  -- manifest-owned idempotency explanation; always refreshed from code on sync
  schedule                TEXT,                       -- cron, or NULL for manual-only
  enabled                 INTEGER NOT NULL DEFAULT 1,
  schedule_overridden     INTEGER NOT NULL DEFAULT 0, -- 1 = user edited the schedule; code-sync preserves it
  schedule_overridden_at  TEXT,                       -- when the override was set (T475); NULL = never overridden, or overridden before this column existed
  max_concurrency         INTEGER,                    -- bounded parallelism for independent stages; NULL = use code default
  max_concurrency_overridden INTEGER NOT NULL DEFAULT 0, -- 1 = user edited maxConcurrency; code-sync preserves it
  max_concurrency_overridden_at TEXT,                 -- when the override was set (T475); NULL = never overridden, or overridden before this column existed
  notify_enabled          INTEGER NOT NULL DEFAULT 1, -- 1 = send the run-end aggregate push notification
  notify_enabled_overridden INTEGER NOT NULL DEFAULT 0, -- 1 = user edited notifyEnabled; code-sync preserves it
  notify_enabled_overridden_at TEXT,                  -- when the override was set (T475); NULL = never overridden, or overridden before this column existed
  certified               INTEGER NOT NULL DEFAULT 0, -- plain user-set "reviewed & settled" flag (T497) — no code/manifest source, so unlike the above there is NO `_overridden` companion column and NO code-sync reconcile; toggle-only, purely informational
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
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
  id             TEXT PRIMARY KEY,
  workflow_name  TEXT NOT NULL,
  status         TEXT NOT NULL,             -- running | success | partial | failed | cancelled
  trigger        TEXT NOT NULL,             -- schedule | manual
  progress       INTEGER NOT NULL DEFAULT 0,
  progress_msg   TEXT NOT NULL DEFAULT '',
  -- Manual run-limit (T094): N originating inputs this run is bounded to, plus the
  -- frozen allowlist of selected root keys (JSON array). Both NULL = unlimited
  -- (scheduled runs are always unlimited). `run_limit` (not `limit` — a SQL keyword).
  run_limit      INTEGER,                   -- NULL = unlimited
  selected_roots TEXT,                      -- JSON array of root keys; NULL = unlimited
  started_at     TEXT,
  finished_at    TEXT,
  duration_ms    INTEGER,
  -- Engine v2 (added to existing DBs by migrateEngineV2; no index here, T098):
  end_reason     TEXT,                      -- why the run ended when that is not obvious from status (e.g. 'orphaned by daemon restart', 'cancelled by user', 'unhandled error: …')
  cycles         INTEGER,                   -- how many repeatUntilStable cycles actually ran
  resumed_from   TEXT,                      -- workflow run id this run resumed from (reusing its succeeded stages' artifacts)
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
CREATE INDEX IF NOT EXISTS idx_workflow_run_logs_ts ON workflow_run_logs(ts, id);

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
  category          TEXT NOT NULL DEFAULT '',
  rate_per_minute   INTEGER,                 -- NULL = no throttle
  daily_cap         INTEGER,                 -- NULL = no daily quota
  monthly_cap       INTEGER,                 -- NULL = no monthly quota
  timeout_ms        INTEGER,                 -- NULL = no override; falls back to ServiceDefinition.timeoutMs / caller default (T465)
  paid              INTEGER NOT NULL DEFAULT 0,
  limits_overridden INTEGER NOT NULL DEFAULT 0, -- 1 = user edited limits; code-sync preserves them
  limits_overridden_at TEXT,                    -- when the override was set (T475); NULL = never overridden, or overridden before this column existed
  rate_limit_source TEXT NOT NULL DEFAULT '', -- manifest-owned provenance of the limit numbers; always refreshed from code on sync
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

-- Runtime-recorded mapping of which jobs have called each service (T186).
-- Populated by callService() in src/core/services.ts — a distinct (service, job)
-- pair is upserted on each call, keeping last_used current.
CREATE TABLE IF NOT EXISTS service_consumers (
  service_name TEXT NOT NULL,
  job_name     TEXT NOT NULL,
  last_used    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (service_name, job_name)
);

CREATE INDEX IF NOT EXISTS idx_service_consumers_service ON service_consumers(service_name);

-- Opt-in short-TTL response cache for 'api'-category services (T451). Populated
-- by callService() in src/core/services.ts when a caller passes cacheKey; the
-- TTL itself is enforced in code (getCachedServiceResponse), not in SQL.
CREATE TABLE IF NOT EXISTS service_cache (
  service_name    TEXT NOT NULL,
  cache_key       TEXT NOT NULL,
  response_json   TEXT NOT NULL,
  cached_at       TEXT NOT NULL,
  PRIMARY KEY (service_name, cache_key)
);

-- ───────────────── Engine v2: run-scoped artifacts and resolved inputs ─────────────────
-- Both tables are BRAND NEW (columns exist on creation for fresh AND existing DBs),
-- so their indexes may live here without hitting the T098 trap.

-- One row per OUTPUT a stage committed during one run attempt. This is the record
-- that makes "this run wrote it" checkable: a downstream stage's input resolves to
-- a row here from the SAME workflow run, never to "whatever file is on disk".
CREATE TABLE IF NOT EXISTS run_artifacts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_run_id TEXT NOT NULL,
  run_id          TEXT NOT NULL,             -- the member run (attempt) that committed it
  cycle           INTEGER NOT NULL DEFAULT 1,
  job_name        TEXT NOT NULL,             -- the producing stage (DAG member name)
  port            TEXT NOT NULL,             -- the stage's output port name
  artifact_key    TEXT NOT NULL,             -- the ArtifactType key (what consumers bind to)
  storage         TEXT NOT NULL,             -- json | file | dir | ledger | inline
  path            TEXT,                      -- stored like detail paths (relative to the workflows root); NULL for ledger/inline
  sha256          TEXT,                      -- content hash at commit (file/json; a listing hash for dir)
  bytes           INTEGER,
  mtime_ms        INTEGER,
  item_count      INTEGER,
  fresh           INTEGER NOT NULL DEFAULT 1, -- 1 = written this run; 0 = explicitly carried forward unchanged
  ok              INTEGER NOT NULL DEFAULT 1, -- the artifact's own check() verdict at commit
  check_json      TEXT,                      -- the GateResult recorded at commit (checks, violations, sample)
  summary_json    TEXT,                      -- { summary, items: IoItem[] (capped sample) }
  inline_json     TEXT,                      -- the value itself, for storage = inline
  note            TEXT,                      -- e.g. the reason given to output.unchanged()
  created_at_ms   INTEGER NOT NULL,
  UNIQUE(run_id, port)
);
CREATE INDEX IF NOT EXISTS idx_run_artifacts_wf ON run_artifacts(workflow_run_id, cycle, job_name, port);

-- One row per INPUT a stage was handed (per producer, for a fan-in port), written
-- by the engine before the stage spawns. This is the gate record: what was checked
-- at that boundary, when, and the verdict, as the engine saw it AT RUN TIME.
CREATE TABLE IF NOT EXISTS run_inputs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_run_id TEXT NOT NULL,
  cycle           INTEGER NOT NULL DEFAULT 1,
  job_name        TEXT NOT NULL,             -- the consuming stage
  port            TEXT NOT NULL,             -- the consumer's input port (the artifact key for a legacy gate)
  producer_job    TEXT NOT NULL,
  artifact_key    TEXT NOT NULL,
  artifact_id     INTEGER,                   -- run_artifacts.id it resolved to; NULL for a legacy gate or an unresolved input
  ok              INTEGER NOT NULL,
  reason          TEXT,                      -- why it failed, when ok = 0
  check_json      TEXT,                      -- recorded check detail (legacy gates: both sides' GateResult)
  used_json       TEXT,                      -- IoItem[] the stage reported it actually used (ctx.input().used())
  duration_ms     INTEGER,
  checked_at_ms   INTEGER NOT NULL,
  UNIQUE(workflow_run_id, cycle, job_name, port, producer_job)
);
CREATE INDEX IF NOT EXISTS idx_run_inputs_wf ON run_inputs(workflow_run_id, job_name);
