// Engine v2: the per-run record of what each stage was handed (run_inputs) and
// what it committed (run_artifacts). This file owns every query on those two
// tables. See the table comments in schema.sql for what each row means.
import { db } from '../index.js';

/** One input a stage was handed, as the engine checked it before the stage ran. */
export interface RunInputRecord {
  workflowRunId: string;
  cycle: number;
  /** The consuming stage. */
  jobName: string;
  /** The consumer's input port (the artifact key itself, for a legacy gate). */
  port: string;
  producerJob: string;
  artifactKey: string;
  /** `run_artifacts.id` it resolved to; null for a legacy gate or an unresolved input. */
  artifactId?: number | null;
  ok: boolean;
  /** Why it failed, when `ok` is false. */
  reason?: string | null;
  /** Whatever detail the check produced (kept as recorded; shown on the gate page). */
  check?: unknown;
  durationMs?: number | null;
}

export interface RunInputRow {
  id: number;
  workflow_run_id: string;
  cycle: number;
  job_name: string;
  port: string;
  producer_job: string;
  artifact_key: string;
  artifact_id: number | null;
  ok: number;
  reason: string | null;
  check_json: string | null;
  used_json: string | null;
  duration_ms: number | null;
  checked_at_ms: number;
}

/**
 * Record (upsert) the verdict on one input boundary. Written by the engine at
 * the moment it checks the boundary, so the run page and gate page can show what
 * was actually checked AT RUN TIME rather than re-running the check later
 * against whatever is on disk by then.
 */
export function recordRunInput(r: RunInputRecord): void {
  db.prepare(`
    INSERT INTO run_inputs (workflow_run_id, cycle, job_name, port, producer_job, artifact_key, artifact_id,
                            ok, reason, check_json, duration_ms, checked_at_ms)
    VALUES (@wf, @cycle, @job, @port, @producer, @key, @artifact, @ok, @reason, @check, @duration, @at)
    ON CONFLICT(workflow_run_id, cycle, job_name, port, producer_job) DO UPDATE SET
      artifact_key = excluded.artifact_key,
      artifact_id = excluded.artifact_id,
      ok = excluded.ok,
      reason = excluded.reason,
      check_json = excluded.check_json,
      duration_ms = excluded.duration_ms,
      checked_at_ms = excluded.checked_at_ms
  `).run({
    wf: r.workflowRunId,
    cycle: r.cycle,
    job: r.jobName,
    port: r.port,
    producer: r.producerJob,
    key: r.artifactKey,
    artifact: r.artifactId ?? null,
    ok: r.ok ? 1 : 0,
    reason: r.reason ?? null,
    check: r.check === undefined ? null : JSON.stringify(r.check),
    duration: r.durationMs ?? null,
    at: Date.now(),
  });
}

/** Every recorded input boundary of a workflow run, oldest first. */
export function runInputsForWorkflowRun(workflowRunId: string): RunInputRow[] {
  return db.prepare('SELECT * FROM run_inputs WHERE workflow_run_id = ? ORDER BY id')
    .all(workflowRunId) as RunInputRow[];
}

/** The recorded inputs of one stage in a workflow run; the latest cycle when `cycle` is omitted. */
export function runInputsForStage(workflowRunId: string, jobName: string, cycle?: number): RunInputRow[] {
  const c = cycle ?? (db.prepare('SELECT MAX(cycle) AS c FROM run_inputs WHERE workflow_run_id = ? AND job_name = ?')
    .get(workflowRunId, jobName) as { c: number | null }).c;
  if (c == null) return [];
  return db.prepare('SELECT * FROM run_inputs WHERE workflow_run_id = ? AND job_name = ? AND cycle = ? ORDER BY id')
    .all(workflowRunId, jobName, c) as RunInputRow[];
}
