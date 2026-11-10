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

// ───────────────────────────── run_artifacts ─────────────────────────────

export interface RunArtifactRow {
  id: number;
  workflow_run_id: string;
  run_id: string;
  cycle: number;
  job_name: string;
  port: string;
  artifact_key: string;
  storage: string;
  /** A stored path (see `toStoredPath`), the ledger job name, or NULL for inline. */
  path: string | null;
  sha256: string | null;
  bytes: number | null;
  mtime_ms: number | null;
  item_count: number | null;
  fresh: number;
  ok: number;
  check_json: string | null;
  summary_json: string | null;
  inline_json: string | null;
  note: string | null;
  created_at_ms: number;
}

/** What a stage commits about one of its outputs. */
export interface RunArtifactRecord {
  workflowRunId: string;
  runId: string;
  cycle: number;
  jobName: string;
  port: string;
  artifactKey: string;
  storage: string;
  path?: string | null;
  sha256?: string | null;
  bytes?: number | null;
  mtimeMs?: number | null;
  itemCount?: number | null;
  fresh: boolean;
  ok: boolean;
  check?: unknown;
  summary?: unknown;
  inlineJson?: string | null;
  note?: string | null;
}

/**
 * Record (upsert per attempt + port) an output a stage committed. Written by the
 * stage's own process, in one statement, AFTER the data itself is in place: a
 * process killed in between leaves data newer than its record, which is the safe
 * direction (the output simply counts as not committed, and the stage fails).
 */
export function recordRunArtifact(a: RunArtifactRecord): number {
  const row = db.prepare(`
    INSERT INTO run_artifacts (workflow_run_id, run_id, cycle, job_name, port, artifact_key, storage, path,
                               sha256, bytes, mtime_ms, item_count, fresh, ok, check_json, summary_json,
                               inline_json, note, created_at_ms)
    VALUES (@wf, @run, @cycle, @job, @port, @key, @storage, @path, @sha, @bytes, @mtime, @count, @fresh, @ok,
            @check, @summary, @inline, @note, @at)
    ON CONFLICT(run_id, port) DO UPDATE SET
      artifact_key = excluded.artifact_key, storage = excluded.storage, path = excluded.path,
      sha256 = excluded.sha256, bytes = excluded.bytes, mtime_ms = excluded.mtime_ms,
      item_count = excluded.item_count, fresh = excluded.fresh, ok = excluded.ok,
      check_json = excluded.check_json, summary_json = excluded.summary_json,
      inline_json = excluded.inline_json, note = excluded.note, created_at_ms = excluded.created_at_ms
    RETURNING id
  `).get({
    wf: a.workflowRunId,
    run: a.runId,
    cycle: a.cycle,
    job: a.jobName,
    port: a.port,
    key: a.artifactKey,
    storage: a.storage,
    path: a.path ?? null,
    sha: a.sha256 ?? null,
    bytes: a.bytes ?? null,
    mtime: a.mtimeMs == null ? null : Math.floor(a.mtimeMs),
    count: a.itemCount ?? null,
    fresh: a.fresh ? 1 : 0,
    ok: a.ok ? 1 : 0,
    check: a.check === undefined ? null : JSON.stringify(a.check),
    summary: a.summary === undefined ? null : JSON.stringify(a.summary),
    inline: a.inlineJson ?? null,
    note: a.note ?? null,
    at: Date.now(),
  }) as { id: number };
  return row.id;
}

export function getRunArtifact(id: number): RunArtifactRow | undefined {
  return db.prepare('SELECT * FROM run_artifacts WHERE id = ?').get(id) as RunArtifactRow | undefined;
}

/** Every output one attempt committed. */
export function artifactsForRun(runId: string): RunArtifactRow[] {
  return db.prepare('SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY id').all(runId) as RunArtifactRow[];
}

/** Every output committed during a workflow run, oldest first. */
export function artifactsForWorkflowRun(workflowRunId: string): RunArtifactRow[] {
  return db.prepare('SELECT * FROM run_artifacts WHERE workflow_run_id = ? ORDER BY id').all(workflowRunId) as RunArtifactRow[];
}

/**
 * The artifact a producer committed for `artifactKey` in THIS workflow run and
 * cycle, taken from the producer's LATEST attempt only. That last clause is the
 * point: an earlier attempt that wrote its output and then failed must not feed
 * a consumer. (A consumer only runs once its producer has settled successfully,
 * so the latest attempt is the successful one.)
 */
export function producedArtifact(
  workflowRunId: string,
  cycle: number,
  producerJob: string,
  artifactKey: string,
): RunArtifactRow | undefined {
  return db.prepare(`
    SELECT a.* FROM run_artifacts a
    WHERE a.workflow_run_id = ? AND a.cycle = ? AND a.job_name = ? AND a.artifact_key = ?
      AND a.run_id = (
        SELECT r.id FROM runs r
        WHERE r.workflow_run_id = ? AND r.job_name = ? AND COALESCE(r.cycle, 1) = ?
        ORDER BY r.rowid DESC LIMIT 1
      )
    ORDER BY a.id DESC LIMIT 1
  `).get(workflowRunId, cycle, producerJob, artifactKey, workflowRunId, producerJob, cycle) as RunArtifactRow | undefined;
}

/**
 * The content fingerprint this stage last committed for a port in any EARLIER
 * attempt or run, used to tell a re-written artifact that actually changed from
 * one that came out identical.
 */
export function previousArtifactSha(jobName: string, port: string, excludingRunId: string): string | null {
  const row = db.prepare(`
    SELECT sha256 FROM run_artifacts
    WHERE job_name = ? AND port = ? AND run_id <> ? AND ok = 1
    ORDER BY id DESC LIMIT 1
  `).get(jobName, port, excludingRunId) as { sha256: string | null } | undefined;
  return row?.sha256 ?? null;
}

/** Did this attempt commit any output whose content is new? */
export function runCommittedFreshArtifact(runId: string): boolean {
  return !!db.prepare('SELECT 1 FROM run_artifacts WHERE run_id = ? AND fresh = 1 AND ok = 1 LIMIT 1').get(runId);
}

/** Record which items of an input a stage reported it actually used. */
export function setRunInputUsed(
  workflowRunId: string,
  cycle: number,
  jobName: string,
  port: string,
  producerJob: string,
  used: unknown,
): void {
  db.prepare(`
    UPDATE run_inputs SET used_json = ?
    WHERE workflow_run_id = ? AND cycle = ? AND job_name = ? AND port = ? AND producer_job = ?
  `).run(JSON.stringify(used), workflowRunId, cycle, jobName, port, producerJob);
}

/** A stage's resolved inputs for one cycle, each with the artifact it resolved to. */
export function resolvedInputsForStage(
  workflowRunId: string,
  jobName: string,
  cycle: number,
): Array<RunInputRow & { artifact: RunArtifactRow | undefined }> {
  return runInputsForStage(workflowRunId, jobName, cycle).map((i) => ({
    ...i,
    artifact: i.artifact_id == null ? undefined : getRunArtifact(i.artifact_id),
  }));
}
