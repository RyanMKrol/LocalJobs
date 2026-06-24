export type RunStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'skipped'; // a workflow member whose upstream dependency did not succeed

export type RunTrigger = 'schedule' | 'manual' | 'workflow';

export type LogLevel = 'info' | 'warn' | 'error';

/** The context handed to every job's run() function. */
export interface JobContext {
  /** Append a log line (also surfaced live in the dashboard). */
  log(message: string, level?: LogLevel): void;
  /** Report progress 0..100 with an optional status message. */
  progress(pct: number, message?: string): void;
  /**
   * The active originating-input allowlist for a LIMITED run (T094), or null when
   * the run is unlimited (the default — process everything). When non-null a job
   * MUST skip any item whose ROOT key is not in this set. Built by the child from
   * the workflow run's frozen `selected_roots`.
   */
  selectedRoots(): ReadonlySet<string> | null;
  /** Convenience over {@link selectedRoots}: true when unlimited OR `rootKey` is selected. */
  rootAllowed(rootKey: string): boolean;
}

/**
 * One thing a contract asserts about its artifact, worded for a NON-EXPERT
 * reader so the dashboard gate page can explain WHAT is checked without anyone
 * reading the code (the "expected shape"). Static — declared on the contract,
 * involves no I/O.
 */
export interface ShapeExpectation {
  /** Short, plain label, e.g. "Contains at least one place". Used to align with
   *  the per-expectation `ExpectationResult.label` from a check. */
  label: string;
  /** Optional longer plain-English explanation of why it matters. */
  detail?: string;
}

/**
 * The machine-readable expected shape of an artifact, surfaced on the gate page
 * as the "expected" side of an expected-vs-actual view. Declared on the
 * contract; purely descriptive (no checking happens here).
 */
export interface ArtifactShape {
  /** One-line plain summary, e.g. "The normalized list of places to look up." */
  summary: string;
  /** The medium/format, e.g. "JSON file", "folder of .txt page captures". */
  format?: string;
  /** The specific expectations the `check` enforces (fields/columns/non-empty). */
  expectations: ShapeExpectation[];
}

/** Pass/fail for ONE expectation against the ACTUAL artifact that flowed. */
export interface ExpectationResult {
  /** Matches a `ShapeExpectation.label` so the page can pair expected ↔ actual. */
  label: string;
  /** Whether the actual artifact satisfied this expectation. */
  ok: boolean;
  /** What was actually observed, e.g. "120 place(s)" / "missing" / 'source = "x"'. */
  actual?: string;
}

/** Outcome of validating one typed-artifact contract at a stage boundary. */
export interface GateResult {
  /** Whether the artifact satisfies the contract. */
  ok: boolean;
  /** When `!ok`: one line per drift detected (e.g. "missing column 'cid'"). */
  violations?: string[];
  /** Optional note logged whether it passes or fails (e.g. "120 rows · 7 cols"). */
  detail?: string;
  /**
   * Per-expectation pass/fail aligned (by `label`) to the contract's declared
   * `shape.expectations` — the EXPECTED-vs-ACTUAL breakdown the gate page
   * renders. Optional: a contract without a `shape` can omit it.
   */
  checks?: ExpectationResult[];
  /**
   * A small plain summary/sample of the ACTUAL artifact that flowed, for the
   * gate page (e.g. "120 place(s) · e.g. \"Blue Bottle\", \"Acme Fire Cult\"").
   */
  sample?: string;
}

/**
 * A typed artifact a job produces or consumes — the contract enforced at a
 * workflow stage boundary. `key` ties a producer's output to its consumer's
 * expectation; `check` inspects the ACTUAL artifact (a data file, a scraped
 * page, …) and reports drift so an external-format change (Takeout CSV layout,
 * Fragrantica page structure) fails LOUD at the exact gate instead of feeding
 * bad data downstream. A `check` that throws is treated as a failed gate.
 */
export interface ArtifactContract {
  /** Stable identifier shared by the producing job and its consumer(s). */
  key: string;
  description?: string;
  /**
   * Optional machine-readable expected shape, surfaced on the dashboard gate
   * page so a reader sees what the gate expects (the "expected" half of an
   * expected-vs-actual view). The `check` should report per-expectation results
   * in `GateResult.checks`, aligned by `label`.
   */
  shape?: ArtifactShape;
  /** Validate the real artifact. Sync or async; throwing counts as a violation. */
  check(): GateResult | Promise<GateResult>;
}

/**
 * A job is a unit of work the orchestrator runs ONLY as a member of a workflow
 * (T037/T070). Workflow-level concerns — scheduling, the enable toggle, manual
 * run — live on the WorkflowDefinition, never here: a job never owns a schedule,
 * an enabled flag, or instructions, and is never run on its own. It runs when its
 * prerequisites are met inside its workflow.
 */
export interface JobDefinition {
  /** Unique, stable identifier (also the primary key in the DB). */
  name: string;
  description?: string;
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
  /**
   * Optional: the set of item keys (the `itemKey`s used with the work_items
   * ledger) currently present in this job's input. Used ONLY by the MANUAL
   * prune feature to find orphaned ledger rows — work_items whose key is no
   * longer in the input (e.g. after source ids are corrected). Nothing in the
   * run/schedule path ever calls this; pruning is never automatic.
   */
  inputKeys?(): string[] | Promise<string[]>;
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
  /** Set when this run is a member of a workflow run; null/absent for standalone runs. */
  workflow_run_id?: string | null;
}

// ─────────────────────────────── Workflows ───────────────────────────────

export type WorkflowRunStatus =
  | 'running'
  | 'success' // every member job succeeded
  | 'partial' // ran to completion but ≥1 member failed/skipped
  | 'failed' // could not run (setup error / no members)
  | 'cancelled'; // orphaned by restart or stopped

/** One node of a workflow DAG: a reference to a job + its upstream deps. */
export interface WorkflowJobRef {
  /** Name of an existing JobDefinition (discovered from a *.job.ts file). */
  job: string;
  /** Sibling member jobs that must SUCCEED before this one starts. */
  dependsOn?: string[];
}

/** A workflow composes existing jobs into a DAG the framework runs as a unit. */
export interface WorkflowDefinition {
  /** Unique, stable identifier (PK in the DB; must not collide with a job name). */
  name: string;
  description?: string;
  /** Cron expression (croner). Omit/null for manual-only. Drives the whole workflow. */
  schedule?: string | null;
  /** Member jobs and their ordering edges. */
  jobs: WorkflowJobRef[];
  /**
   * Bounded parallelism for independent branches (no `dependsOn` between them).
   * Default 4 (T156): same-wave stages whose deps are satisfied run concurrently
   * up to this cap. Set higher for a wide fan-out, or `1` to force strict
   * sequential order. Each parallel stage spawns its own child process, so keep it
   * modest. Strictly-linear workflows are unaffected (one ready stage at a time).
   */
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

export interface WorkflowRunRow {
  id: string;
  workflow_name: string;
  status: WorkflowRunStatus;
  trigger: RunTrigger;
  /** Overall 0..100, rolled up in real time from member-job progress over the
   *  workflow's total stage count (see `rollUpWorkflowProgress` in the store). */
  progress: number;
  progress_msg: string;
  /** Manual run-limit: N originating inputs this run was bounded to (T094); null = unlimited. */
  run_limit: number | null;
  /** Frozen allowlist of selected root keys (JSON string in the DB); null = unlimited. */
  selected_roots: string | null;
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
