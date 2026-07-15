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
 * Filesystem cleanup (data/out/**) is performed by the API layer after calling this.
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

