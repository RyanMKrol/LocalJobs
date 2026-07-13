import { randomUUID } from 'node:crypto';
import { db } from '../index.js';
import type { LogLevel, RunRow, RunStatus, RunTrigger } from '../../core/types.js';
import { rollUpWorkflowProgress } from './workflows.js';

function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// ---- runs ----

export function createRun(
  jobName: string,
  trigger: RunTrigger,
  attempt = 1,
  workflowRunId: string | null = null,
): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO runs (id, job_name, status, trigger, attempt, started_at, workflow_run_id)
    VALUES (?, ?, 'running', ?, ?, datetime('now'), ?)
  `).run(id, jobName, trigger, attempt, workflowRunId);
  return id;
}

/** Record a terminal run row without spawning a process — used for workflow
 *  members that are SKIPPED because an upstream dependency didn't succeed. */
export function recordSkippedRun(jobName: string, workflowRunId: string, reason: string): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO runs (id, job_name, status, trigger, attempt, started_at, finished_at, duration_ms, error, workflow_run_id)
    VALUES (?, ?, 'skipped', 'workflow', 1, datetime('now'), datetime('now'), 0, ?, ?)
  `).run(id, jobName, reason, workflowRunId);
  return id;
}

/** Record a terminal FAILED run row without spawning a process — used when a
 *  validation gate between workflow stages is violated, so the consumer never
 *  runs but the failure is surfaced as a first-class failed run (with the drift
 *  detail in `error`). */
export function recordGateFailure(jobName: string, workflowRunId: string, error: string): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO runs (id, job_name, status, trigger, attempt, started_at, finished_at, duration_ms, error, workflow_run_id)
    VALUES (?, ?, 'failed', 'workflow', 1, datetime('now'), datetime('now'), 0, ?, ?)
  `).run(id, jobName, error, workflowRunId);
  return id;
}

export function setProgress(runId: string, pct: number, message: string): void {
  db.prepare('UPDATE runs SET progress = ?, progress_msg = ? WHERE id = ?')
    .run(Math.max(0, Math.min(100, Math.round(pct))), message, runId);
  // If this run is a workflow member, roll its progress up into the parent
  // workflow run in real time, so the workflow reflects in-flight member
  // progress rather than only whole settled stages.
  const row = db.prepare('SELECT workflow_run_id FROM runs WHERE id = ?')
    .get(runId) as { workflow_run_id: string | null } | undefined;
  if (row?.workflow_run_id) rollUpWorkflowProgress(row.workflow_run_id);
}

export function finishRun(
  runId: string,
  status: RunStatus,
  opts: { exitCode?: number | null; error?: string | null } = {},
): void {
  db.prepare(`
    UPDATE runs SET
      status = ?,
      finished_at = datetime('now'),
      duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER),
      exit_code = ?,
      error = ?,
      progress = CASE WHEN ? = 'success' THEN 100 ELSE progress END
    WHERE id = ?
  `).run(status, opts.exitCode ?? null, opts.error ?? null, status, runId);
}

/**
 * Mark a member run as a noop: updates its status to `'skipped'` in-place
 * without resetting timing (the run completed at the recorded time, just with
 * nothing to do). Called by the workflow executor after `hasJobAdvancedAnyItem`
 * returns false for a successful stage. T258.
 */
export function setRunNoop(runId: string): void {
  db.prepare("UPDATE runs SET status = 'skipped' WHERE id = ?").run(runId);
}

/**
 * Did the given job advance any work items during this specific workflow run?
 * Checks `work_item_runs` for any row with (workflow_run_id, job_name). Returns
 * false when the job ran but called no `markWorkItem` — i.e. nothing to do.
 * Used by the workflow executor to detect noop stages (T258).
 */
export function hasJobAdvancedAnyItem(workflowRunId: string, jobName: string): boolean {
  return !!db.prepare('SELECT 1 FROM work_item_runs WHERE workflow_run_id = ? AND job_name = ? LIMIT 1')
    .get(workflowRunId, jobName);
}

/**
 * Did ANY stage advance any work items during this workflow run? (T258)
 * Returns false only when the entire run made no `markWorkItem` calls — the
 * workflow was a complete noop. Used to settle the workflow run as `'skipped'`
 * rather than `'success'` when all stages had nothing to do.
 */
export function workflowRunAdvancedAnyItem(workflowRunId: string): boolean {
  return !!db.prepare('SELECT 1 FROM work_item_runs WHERE workflow_run_id = ? LIMIT 1')
    .get(workflowRunId);
}

export function addLog(runId: string, message: string, level: LogLevel = 'info'): void {
  db.prepare('INSERT INTO run_logs (run_id, level, message) VALUES (?, ?, ?)')
    .run(runId, level, message);
}

export function getRun(runId: string): RunRow | undefined {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
}

export function listRunsForJob(jobName: string, limit = 50): RunRow[] {
  return db.prepare('SELECT * FROM runs WHERE job_name = ? ORDER BY started_at DESC LIMIT ?')
    .all(jobName, limit) as RunRow[];
}

export function listRecentRuns(limit = 50): RunRow[] {
  return db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit) as RunRow[];
}

export function getLogs(runId: string, afterId = 0): { id: number; ts: string; level: LogLevel; message: string }[] {
  return db.prepare('SELECT id, ts, level, message FROM run_logs WHERE run_id = ? AND id > ? ORDER BY id')
    .all(runId, afterId) as { id: number; ts: string; level: LogLevel; message: string }[];
}

export interface GlobalLogFilter {
  levels?: LogLevel[];      // omitted/empty = all levels
  job?: string;              // filter to run_logs from this job only
  workflow?: string;         // filter to workflow_run_logs from this workflow only (mutually exclusive with `job` — caller/route enforces this, not the store fn)
  q?: string;                 // free-text substring match against `message`, case-insensitive
  windowHours?: number;       // only applied when `before` is absent (first page)
  before?: string;            // opaque cursor from a previous page's LAST returned row; when present, ignore windowHours entirely and return older rows
  limit?: number;             // default 200, caller (route) is responsible for clamping to a sane max
}

export interface GlobalLogLine {
  id: number;
  ts: string;
  level: LogLevel;
  message: string;
  source: 'job' | 'workflow';
  jobName: string | null;
  workflowName: string | null;
  runId: string | null;
  workflowRunId: string | null;
}

interface LogCursor {
  ts: string;
  source: 'job' | 'workflow';
  id: number;
}

function encodeLogCursor(c: LogCursor): string {
  return `${c.ts}|${c.source}|${c.id}`;
}

function decodeLogCursor(raw: string): LogCursor {
  const parts = raw.split('|');
  const ts = parts[0];
  const source = parts[1] === 'workflow' ? 'workflow' : 'job';
  const id = Number(parts[2]);
  return { ts, source, id };
}

/**
 * Global cross-cutting log feed merging run_logs (per job run) and
 * workflow_run_logs (per workflow run), newest first. Total sort order is
 * (ts DESC, source ASC ['job' < 'workflow'], id DESC) — a genuine total order
 * needed because `ts` is second-granularity and routinely ties across rows.
 */
export function listGlobalLogs(filter: GlobalLogFilter): { logs: GlobalLogLine[]; nextCursor: string | null } {
  const limit = filter.limit ?? 200;
  const cursor = filter.before ? decodeLogCursor(filter.before) : null;
  const levels = filter.levels && filter.levels.length > 0 ? filter.levels : null;

  const wantJob = !filter.workflow;
  const wantWorkflow = !filter.job;

  const jobRows: GlobalLogLine[] = [];
  if (wantJob) {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.job) {
      conds.push('r.job_name = ?');
      params.push(filter.job);
    }
    if (levels) {
      conds.push(`rl.level IN (${levels.map(() => '?').join(',')})`);
      params.push(...levels);
    }
    if (filter.q) {
      conds.push("LOWER(rl.message) LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(filter.q.toLowerCase())}%`);
    }
    if (cursor) {
      // rows strictly after the cursor in (ts DESC, source ASC, id DESC) order
      conds.push(
        `(rl.ts < ? OR (rl.ts = ? AND (? < 'job' OR (? = 'job' AND rl.id < ?))))`
      );
      params.push(cursor.ts, cursor.ts, cursor.source, cursor.source, cursor.id);
    } else if (filter.windowHours != null) {
      conds.push(`rl.ts >= datetime('now', ?)`);
      params.push(`-${filter.windowHours} hours`);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT rl.id AS id, rl.ts AS ts, rl.level AS level, rl.message AS message,
              r.job_name AS jobName, rl.run_id AS runId
       FROM run_logs rl
       JOIN runs r ON r.id = rl.run_id
       ${where}
       ORDER BY rl.ts DESC, rl.id DESC
       LIMIT ?`
    ).all(...params, limit) as { id: number; ts: string; level: LogLevel; message: string; jobName: string; runId: string }[];
    for (const row of rows) {
      jobRows.push({
        id: row.id,
        ts: row.ts,
        level: row.level,
        message: row.message,
        source: 'job',
        jobName: row.jobName,
        workflowName: null,
        runId: row.runId,
        workflowRunId: null,
      });
    }
  }

  const workflowRows: GlobalLogLine[] = [];
  if (wantWorkflow) {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.workflow) {
      conds.push('wr.workflow_name = ?');
      params.push(filter.workflow);
    }
    if (levels) {
      conds.push(`wrl.level IN (${levels.map(() => '?').join(',')})`);
      params.push(...levels);
    }
    if (filter.q) {
      conds.push("LOWER(wrl.message) LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(filter.q.toLowerCase())}%`);
    }
    if (cursor) {
      conds.push(
        `(wrl.ts < ? OR (wrl.ts = ? AND (? < 'workflow' OR (? = 'workflow' AND wrl.id < ?))))`
      );
      params.push(cursor.ts, cursor.ts, cursor.source, cursor.source, cursor.id);
    } else if (filter.windowHours != null) {
      conds.push(`wrl.ts >= datetime('now', ?)`);
      params.push(`-${filter.windowHours} hours`);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT wrl.id AS id, wrl.ts AS ts, wrl.level AS level, wrl.message AS message,
              wr.workflow_name AS workflowName, wrl.workflow_run_id AS workflowRunId
       FROM workflow_run_logs wrl
       JOIN workflow_runs wr ON wr.id = wrl.workflow_run_id
       ${where}
       ORDER BY wrl.ts DESC, wrl.id DESC
       LIMIT ?`
    ).all(...params, limit) as { id: number; ts: string; level: LogLevel; message: string; workflowName: string; workflowRunId: string }[];
    for (const row of rows) {
      workflowRows.push({
        id: row.id,
        ts: row.ts,
        level: row.level,
        message: row.message,
        source: 'workflow',
        jobName: null,
        workflowName: row.workflowName,
        runId: null,
        workflowRunId: row.workflowRunId,
      });
    }
  }

  const merged = [...jobRows, ...workflowRows].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return b.id - a.id;
  });

  const page = merged.slice(0, limit);
  const nextCursor = page.length === limit
    ? encodeLogCursor({ ts: page[page.length - 1].ts, source: page[page.length - 1].source, id: page[page.length - 1].id })
    : null;

  return { logs: page, nextCursor };
}

export function hasActiveRun(jobName: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE job_name = ? AND status = 'running'`)
    .get(jobName) as { n: number };
  return row.n > 0;
}

export function lastRunForJob(jobName: string): RunRow | undefined {
  return db.prepare('SELECT * FROM runs WHERE job_name = ? ORDER BY started_at DESC LIMIT 1')
    .get(jobName) as RunRow | undefined;
}

/** On daemon startup, any run still marked 'running' is orphaned from a crash. */
export function reapOrphanRuns(): number {
  const res = db.prepare(`
    UPDATE runs SET status = 'cancelled', finished_at = datetime('now'),
      error = 'Orphaned by daemon restart'
    WHERE status = 'running'
  `).run();
  return res.changes;
}
