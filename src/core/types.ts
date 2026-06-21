export type RunStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'skipped'; // a pipeline member whose upstream dependency did not succeed

export type RunTrigger = 'schedule' | 'manual' | 'pipeline';

export type LogLevel = 'info' | 'warn' | 'error';

/** The context handed to every job's run() function. */
export interface JobContext {
  /** Append a log line (also surfaced live in the dashboard). */
  log(message: string, level?: LogLevel): void;
  /** Report progress 0..100 with an optional status message. */
  progress(pct: number, message?: string): void;
}

/** Outcome of validating one typed-artifact contract at a stage boundary. */
export interface GateResult {
  /** Whether the artifact satisfies the contract. */
  ok: boolean;
  /** When `!ok`: one line per drift detected (e.g. "missing column 'cid'"). */
  violations?: string[];
  /** Optional note logged whether it passes or fails (e.g. "120 rows · 7 cols"). */
  detail?: string;
}

/**
 * A typed artifact a job produces or consumes — the contract enforced at a
 * pipeline stage boundary. `key` ties a producer's output to its consumer's
 * expectation; `check` inspects the ACTUAL artifact (a data file, a scraped
 * page, …) and reports drift so an external-format change (Takeout CSV layout,
 * Fragrantica page structure) fails LOUD at the exact gate instead of feeding
 * bad data downstream. A `check` that throws is treated as a failed gate.
 */
export interface ArtifactContract {
  /** Stable identifier shared by the producing job and its consumer(s). */
  key: string;
  description?: string;
  /** Validate the real artifact. Sync or async; throwing counts as a violation. */
  check(): GateResult | Promise<GateResult>;
}

/** A job is a unit of work the orchestrator can schedule and run. */
export interface JobDefinition {
  /** Unique, stable identifier (also the primary key in the DB). */
  name: string;
  description?: string;
  /**
   * Optional human instructions shown on the dashboard — e.g. any manual setup
   * needed before a run (like placing input data). Plain text; newlines kept.
   */
  instructions?: string;
  /** Cron expression (croner syntax). Omit/null for manual-only jobs. */
  schedule?: string | null;
  /** Hard timeout in ms; the child process is killed if exceeded. 0 = none. */
  timeoutMs?: number;
  /** How many times to retry on failure before marking the run failed. */
  maxRetries?: number;
  /**
   * Typed artifacts this job emits. Each is validated AFTER the job succeeds and
   * before a downstream consumer of the same `key` starts (the producer side of
   * the stage gate).
   */
  produces?: ArtifactContract[];
  /**
   * Typed artifacts this job requires. Each is validated BEFORE the job starts,
   * against the artifact left by a successful upstream producer of the same
   * `key` (the consumer side of the stage gate).
   */
  consumes?: ArtifactContract[];
  run(ctx: JobContext): Promise<void>;
}

/** NDJSON events the child job process emits on stdout. */
export type JobEvent =
  | { type: 'log'; level: LogLevel; message: string }
  | { type: 'progress'; pct: number; message: string }
  | { type: 'result'; status: 'success'; }
  | { type: 'result'; status: 'failed'; error: string };

export interface RunRow {
  id: string;
  job_name: string;
  status: RunStatus;
  trigger: RunTrigger;
  attempt: number;
  progress: number;
  progress_msg: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  error: string | null;
  /** Set when this run is a member of a pipeline run; null/absent for standalone runs. */
  pipeline_run_id?: string | null;
}

// ─────────────────────────────── Pipelines ───────────────────────────────

export type PipelineRunStatus =
  | 'running'
  | 'success' // every member job succeeded
  | 'partial' // ran to completion but ≥1 member failed/skipped
  | 'failed' // could not run (setup error / no members)
  | 'cancelled'; // orphaned by restart or stopped

/** One node of a pipeline DAG: a reference to a job + its upstream deps. */
export interface PipelineJobRef {
  /** Name of an existing JobDefinition (discovered from a *.job.ts file). */
  job: string;
  /** Sibling member jobs that must SUCCEED before this one starts. */
  dependsOn?: string[];
}

/** A pipeline composes existing jobs into a DAG the framework runs as a unit. */
export interface PipelineDefinition {
  /** Unique, stable identifier (PK in the DB; must not collide with a job name). */
  name: string;
  description?: string;
  /** Cron expression (croner). Omit/null for manual-only. Drives the whole pipeline. */
  schedule?: string | null;
  /** Member jobs and their ordering edges. */
  jobs: PipelineJobRef[];
  /** Bounded parallelism for independent branches. Default 1 (serial topo order). */
  maxConcurrency?: number;
  /** Re-run the whole pass in cycles until no retryable work remains. Default false. */
  repeatUntilStable?: boolean;
  /** Max cycles when repeatUntilStable. Default 1. */
  maxCycles?: number;
  /** Sleep between cycles (ms). Default 0. */
  cycleSleepMs?: number;
  /** work_items retry budget used to judge "retryable work left". Default 4. */
  minAttempts?: number;
}

export interface PipelineRunRow {
  id: string;
  pipeline_name: string;
  status: PipelineRunStatus;
  trigger: RunTrigger;
  progress: number;
  progress_msg: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}

// ──────────────────────────────── Services ───────────────────────────────

/** An external dependency with shared, cross-job rate + quota limits. */
export interface ServiceDefinition {
  /** Unique identifier, e.g. 'gemini', 'google-places', 'fragrantica', 'claude-cli'. */
  name: string;
  description?: string;
  /** Throttle: max calls per rolling 60s. Omit for no rate throttle. */
  ratePerMinute?: number;
  /** Minimum gap between consecutive calls (ms) — fixed spacing for things that
   *  must not burst (e.g. a scrape behind Cloudflare). Takes precedence over
   *  ratePerMinute when set. */
  minIntervalMs?: number;
  /** Optional extra random delay (0..maxJitterMs) added after the min-interval. */
  maxJitterMs?: number;
  /** Quota: max calls per calendar day. Omit for no daily cap. */
  dailyCap?: number;
  /** Quota: max calls per calendar month. Omit for no monthly cap. */
  monthlyCap?: number;
  /** Whether calls cost real money (paid APIs get extra care in testing/UI). */
  paid?: boolean;
}
