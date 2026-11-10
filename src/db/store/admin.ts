import { db } from '../index.js';
import { listJobs } from './jobs.js';
import { getWorkflowJobs, listWorkflows } from './workflows.js';
import { listServices } from './services.js';

// ═══════════════════════ stale override audit (T475) ═══════════════════════

/**
 * A single `_overridden` flag found set across services/workflows/jobs, for the
 * `overrides-audit` workflow's report. `ageMs` is `null` when the override's
 * `_overridden_at` is NULL — either the flag was set before that column existed
 * (unknown age), or (in principle) some future path re-sets `_overridden` without
 * stamping the timestamp; either way, treat it as "unknown age, always report".
 */
export interface StaleOverride {
  table: 'services' | 'workflows' | 'jobs';
  name: string;
  field: string;
  currentValue: unknown;
  overriddenAt: string | null;
  ageMs: number | null;
}

/**
 * Every currently-set `_overridden` flag across services/workflows/jobs whose
 * override is either unknown-age (`_overridden_at IS NULL`) or has been live for
 * at least `minAgeMs`. Used by the `overrides-audit` workflow to nudge a stable
 * override into becoming the manifest's code default (see the root CLAUDE.md
 * Conventions section: an override is provisional, not a place to retire a value).
 */
export function listStaleOverrides(minAgeMs: number): StaleOverride[] {
  const now = Date.now();
  const isStale = (overriddenAt: string | null): boolean => {
    if (!overriddenAt) return true;
    // SQLite datetimes are UTC strings without a trailing 'Z' (see root CLAUDE.md
    // Gotchas) — append it so Date parses them as UTC, not local time.
    const ts = Date.parse(overriddenAt.endsWith('Z') ? overriddenAt : `${overriddenAt}Z`);
    if (Number.isNaN(ts)) return true;
    return now - ts >= minAgeMs;
  };
  const ageOf = (overriddenAt: string | null): number | null => {
    if (!overriddenAt) return null;
    const ts = Date.parse(overriddenAt.endsWith('Z') ? overriddenAt : `${overriddenAt}Z`);
    return Number.isNaN(ts) ? null : now - ts;
  };

  const out: StaleOverride[] = [];

  for (const s of listServices()) {
    if (s.limits_overridden !== 1 || !isStale(s.limits_overridden_at)) continue;
    out.push({
      table: 'services',
      name: s.name,
      field: 'limits',
      currentValue: {
        rate_per_minute: s.rate_per_minute,
        daily_cap: s.daily_cap,
        monthly_cap: s.monthly_cap,
        timeout_ms: s.timeout_ms,
      },
      overriddenAt: s.limits_overridden_at,
      ageMs: ageOf(s.limits_overridden_at),
    });
  }

  for (const w of listWorkflows()) {
    if (w.schedule_overridden === 1 && isStale(w.schedule_overridden_at)) {
      out.push({
        table: 'workflows',
        name: w.name,
        field: 'schedule',
        currentValue: w.schedule,
        overriddenAt: w.schedule_overridden_at,
        ageMs: ageOf(w.schedule_overridden_at),
      });
    }
    if (w.max_concurrency_overridden === 1 && isStale(w.max_concurrency_overridden_at)) {
      out.push({
        table: 'workflows',
        name: w.name,
        field: 'max_concurrency',
        currentValue: w.max_concurrency,
        overriddenAt: w.max_concurrency_overridden_at,
        ageMs: ageOf(w.max_concurrency_overridden_at),
      });
    }
    if (w.notify_enabled_overridden === 1 && isStale(w.notify_enabled_overridden_at)) {
      out.push({
        table: 'workflows',
        name: w.name,
        field: 'notify_enabled',
        currentValue: w.notify_enabled,
        overriddenAt: w.notify_enabled_overridden_at,
        ageMs: ageOf(w.notify_enabled_overridden_at),
      });
    }
  }

  for (const j of listJobs()) {
    if (j.timeout_ms_overridden !== 1 || !isStale(j.timeout_ms_overridden_at)) continue;
    out.push({
      table: 'jobs',
      name: j.name,
      field: 'timeout_ms',
      currentValue: j.timeout_ms,
      overriddenAt: j.timeout_ms_overridden_at,
      ageMs: ageOf(j.timeout_ms_overridden_at),
    });
  }

  return out;
}

/**
 * One-time recovery helper: delete `success` rows for a job whose `detail` JSON has
 * `[field] == null` — for clearing rows a bug incorrectly recorded as succeeded (e.g.
 * stock-sector-lookup recording a null Finnhub result as 'success' before this fix).
 * Returns the item_keys removed so the caller can report exactly what was reset.
 */
export function deleteNullDetailSuccessItems(jobName: string, field: string): string[] {
  const rows = db.prepare(
    "SELECT item_key, detail FROM work_items WHERE job_name = ? AND status = 'success'",
  ).all(jobName) as { item_key: string; detail: string | null }[];

  const toRemove: string[] = [];
  for (const row of rows) {
    if (!row.detail) continue;
    try {
      const parsed = JSON.parse(row.detail) as Record<string, unknown>;
      if (parsed[field] === null) toRemove.push(row.item_key);
    } catch { /* ignore malformed detail */ }
  }

  if (toRemove.length === 0) return [];

  const del = db.prepare("DELETE FROM work_items WHERE job_name = ? AND item_key = ? AND status = 'success'");
  const tx = db.transaction((keys: string[]) => { for (const key of keys) del.run(jobName, key); });
  tx(toRemove);

  return toRemove;
}

// ════════════════════ workflow output reset (T203) ════════════════════

export interface WorkflowResetResult {
  jobNames: string[];
  itemsDeleted: number;
  runsDeleted: number;
  wfRunsDeleted: number;
}

/**
 * Clear ALL output data for a workflow — scoped to its member jobs.
 * Deletes in a single transaction:
 *   • `work_item_runs` attribution rows for the member jobs
 *   • `work_items` ledger rows for the member jobs
 *   • `run_logs` for those jobs' runs
 *   • `runs` for those jobs
 *   • `workflow_run_logs` for those workflow runs
 *   • `workflow_runs` for the named workflow
 *
 * Does NOT touch: `data/raw/**` files, definition tables (jobs/workflows/services),
 * user settings (enabled/schedule/concurrency overrides, service limits), or
 * `service_usage` (a cross-workflow spend meter).
 *
 * Filesystem cleanup (data/out/** How many rows a ledger holds (and how many per-run records point at it). */
export function ledgerSize(jobName: string): { workItems: number; workItemRuns: number } {
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE job_name = ?`).get(jobName) as { n: number }).n;
  return { workItems: count('work_items'), workItemRuns: count('work_item_runs') };
}

/**
 * Delete one job's whole ledger: its `work_items` rows and the per-run records of
 * them. For a ledger that existed only to be displayed and whose stage now
 * declares its output instead (see scripts/cleanup-legacy-display-rows.ts). Never
 * called by a run. Runs, logs and every other job's ledger are untouched.
 */
export function deleteLedgerOfJob(jobName: string): { workItems: number; workItemRuns: number } {
  return db.transaction(() => {
    const workItemRuns = db.prepare('DELETE FROM work_item_runs WHERE job_name = ?').run(jobName).changes;
    const workItems = db.prepare('DELETE FROM work_items WHERE job_name = ?').run(jobName).changes;
    return { workItems, workItemRuns };
  }).immediate();
}

/**) is performed by the API layer after calling this.
 * MANUAL ONLY — never invoked from the run/schedule path.
 */
export function resetWorkflowOutput(workflowName: string): WorkflowResetResult {
  const members = getWorkflowJobs(workflowName);
  const jobNames = members.map((m) => m.job_name);
  if (jobNames.length === 0) {
    return { jobNames: [], itemsDeleted: 0, runsDeleted: 0, wfRunsDeleted: 0 };
  }
  const ph = jobNames.map(() => '?').join(',');

  const tx = db.transaction(() => {
    // work_item_runs: attribution rows for member jobs
    db.prepare(`DELETE FROM work_item_runs WHERE job_name IN (${ph})`).run(...jobNames);
    // …and any written under another ledger name during this workflow's runs
    db.prepare('DELETE FROM work_item_runs WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE workflow_name = ?)').run(workflowName);
    // run_artifacts / run_inputs: the per-run record of what each stage read and wrote
    db.prepare('DELETE FROM run_artifacts WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE workflow_name = ?)').run(workflowName);
    db.prepare('DELETE FROM run_inputs WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE workflow_name = ?)').run(workflowName);
    // work_items: ledger rows for member jobs
    const itemsDeleted = db.prepare(`DELETE FROM work_items WHERE job_name IN (${ph})`).run(...jobNames).changes;
    // run_logs: cascade-delete before runs (subquery avoids large IN lists)
    db.prepare(`DELETE FROM run_logs WHERE run_id IN (SELECT id FROM runs WHERE job_name IN (${ph}))`).run(...jobNames);
    // runs: member job runs
    const runsDeleted = db.prepare(`DELETE FROM runs WHERE job_name IN (${ph})`).run(...jobNames).changes;
    // workflow_run_logs: cascade-delete before workflow_runs
    db.prepare('DELETE FROM workflow_run_logs WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE workflow_name = ?)').run(workflowName);
    // workflow_runs: all runs of this workflow
    const wfRunsDeleted = db.prepare('DELETE FROM workflow_runs WHERE workflow_name = ?').run(workflowName).changes;
    return { itemsDeleted, runsDeleted, wfRunsDeleted };
  });

  const result = tx();
  return { jobNames, ...result };
}

// ─────────────────── One-off admin: full delete of a stale definition ───────────────────
// Unlike resetWorkflowOutput (which clears OUTPUT but keeps the definition rows),
// these remove the DEFINITION itself + everything under it — for permanently
// retiring a workflow/job/service whose code no longer exists. MANUAL ONLY,
// intended for one-off cleanup scripts (see scripts/cleanup-listens-spotify.ts).

export interface WorkflowDeleteResult {
  workflows: number;
  workflowJobs: number;
  workflowRuns: number;
  workflowRunLogs: number;
}

/** Delete a workflow definition and everything under it. Idempotent (no-op if absent). */
export function deleteWorkflowCompletely(workflowName: string): WorkflowDeleteResult {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM run_artifacts WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE workflow_name = ?)').run(workflowName);
    db.prepare('DELETE FROM run_inputs WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE workflow_name = ?)').run(workflowName);
    const workflowRunLogs = db.prepare(
      'DELETE FROM workflow_run_logs WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE workflow_name = ?)'
    ).run(workflowName).changes;
    const workflowRuns = db.prepare('DELETE FROM workflow_runs WHERE workflow_name = ?').run(workflowName).changes;
    const workflowJobs = db.prepare('DELETE FROM workflow_jobs WHERE workflow_name = ?').run(workflowName).changes;
    const workflows = db.prepare('DELETE FROM workflows WHERE name = ?').run(workflowName).changes;
    return { workflows, workflowJobs, workflowRuns, workflowRunLogs };
  });
  return tx();
}

export interface JobDeleteResult {
  jobs: number;
  runs: number;
  runLogs: number;
  workItems: number;
  workItemRuns: number;
}

/** Delete a job definition and everything under it. Idempotent (no-op if absent). */
export function deleteJobCompletely(jobName: string): JobDeleteResult {
  const tx = db.transaction(() => {
    const runLogs = db.prepare(
      'DELETE FROM run_logs WHERE run_id IN (SELECT id FROM runs WHERE job_name = ?)'
    ).run(jobName).changes;
    const runs = db.prepare('DELETE FROM runs WHERE job_name = ?').run(jobName).changes;
    const workItemRuns = db.prepare('DELETE FROM work_item_runs WHERE job_name = ?').run(jobName).changes;
    const workItems = db.prepare('DELETE FROM work_items WHERE job_name = ?').run(jobName).changes;
    const jobs = db.prepare('DELETE FROM jobs WHERE name = ?').run(jobName).changes;
    return { jobs, runs, runLogs, workItems, workItemRuns };
  });
  return tx();
}

export interface ServiceDeleteResult {
  services: number;
  serviceConsumers: number;
  serviceUsage: number;
}

/** Delete a service definition and everything under it. Idempotent (no-op if absent). */
export function deleteServiceCompletely(serviceName: string): ServiceDeleteResult {
  const tx = db.transaction(() => {
    const serviceUsage = db.prepare('DELETE FROM service_usage WHERE service = ?').run(serviceName).changes;
    const serviceConsumers = db.prepare('DELETE FROM service_consumers WHERE service_name = ?').run(serviceName).changes;
    const services = db.prepare('DELETE FROM services WHERE name = ?').run(serviceName).changes;
    return { services, serviceConsumers, serviceUsage };
  });
  return tx();
}


// ─────────────────── Retention: per-run I/O detail of old runs ───────────────────

export interface RunHistoryRetention {
  /** Runs that STARTED more than this many days ago are eligible. Default 90. */
  keepDays?: number;
  /** …unless they are among this many most recent runs of their workflow. Default 20. */
  keepRunsPerWorkflow?: number;
  /** Max rows deleted per call, so each call is one short write. Default 5000. */
  chunk?: number;
}

/**
 * Delete ONE chunk of per-run I/O detail belonging to old workflow runs, and say
 * whether more remains. "Per-run I/O detail" is `work_item_runs` (which items a
 * run touched, and what it recorded about them), `run_artifacts` and `run_inputs`.
 *
 * What is kept, always: the run itself (`workflow_runs`, its member `runs`, every
 * log line), and the `work_items` ledger. So an old run still shows its status,
 * stages, timings and logs; only its Inputs & Outputs lists go. A run is eligible
 * when it started more than `keepDays` ago AND is not among its workflow's
 * `keepRunsPerWorkflow` most recent runs AND is not running, so a workflow that
 * runs monthly keeps well over `keepDays` of detail.
 *
 * Why it exists: `work_item_runs` gains a row per item per run with no upper
 * bound (a library-wide workflow adds tens of thousands a day), and nothing ever
 * removed them. Deleting in small chunks keeps each write lock short, so jobs
 * running at the same time are never blocked for long; the caller loops until
 * `done`.
 */
export function pruneRunHistoryChunk(opts: RunHistoryRetention = {}): { deleted: number; done: boolean } {
  const keepDays = Math.max(1, opts.keepDays ?? 90);
  const keepRuns = Math.max(1, opts.keepRunsPerWorkflow ?? 20);
  const chunk = Math.max(1, opts.chunk ?? 5000);

  // The oldest eligible run that still has any detail left to delete.
  const target = db.prepare(`
    SELECT w.id AS id FROM workflow_runs w
    WHERE w.status <> 'running'
      AND w.started_at < datetime('now', ?)
      AND w.id NOT IN (
        SELECT w2.id FROM workflow_runs w2
        WHERE w2.workflow_name = w.workflow_name
        ORDER BY w2.started_at DESC, w2.rowid DESC
        LIMIT ?
      )
      AND (
        EXISTS (SELECT 1 FROM work_item_runs r WHERE r.workflow_run_id = w.id)
        OR EXISTS (SELECT 1 FROM run_artifacts a WHERE a.workflow_run_id = w.id)
        OR EXISTS (SELECT 1 FROM run_inputs i WHERE i.workflow_run_id = w.id)
      )
    ORDER BY w.started_at, w.rowid
    LIMIT 1
  `).get(`-${keepDays} days`, keepRuns) as { id: string } | undefined;
  if (!target) return { deleted: 0, done: true };

  const deleted = db.transaction((): number => {
    let n = db.prepare(`
      DELETE FROM work_item_runs WHERE rowid IN (
        SELECT rowid FROM work_item_runs WHERE workflow_run_id = ? LIMIT ?
      )
    `).run(target.id, chunk).changes;
    if (n < chunk) {
      // The big table is drained for this run; its small per-run records go in the same write.
      n += db.prepare('DELETE FROM run_artifacts WHERE workflow_run_id = ?').run(target.id).changes;
      n += db.prepare('DELETE FROM run_inputs WHERE workflow_run_id = ?').run(target.id).changes;
    }
    return n;
  }).immediate();
  return { deleted, done: false };
}
