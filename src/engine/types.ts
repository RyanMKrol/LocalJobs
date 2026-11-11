// The workflow engine's own types: runs, jobs, workflows, gates. Nothing here knows
// about any particular workflow, service or dashboard.
import type { InputPort, IoItem, OutputPort, StateDecl } from './ports.js';

export type RunStatus =
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
 * artifact type; purely descriptive (no checking happens here).
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

/** The outcome of checking one artifact (an artifact type's `check`). */
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
   * Optional: the set of item keys (the `itemKey`s used with the work_items
   * ledger) currently present in this job's input. Used ONLY by the MANUAL
   * prune feature to find orphaned ledger rows — work_items whose key is no
   * longer in the input (e.g. after source ids are corrected). Nothing in the
   * run/schedule path ever calls this; pruning is never automatic.
   */
  inputKeys?(): string[] | Promise<string[]>;
  /**
   * Optional: names the ServiceDefinition (by its `name`) that the job's
   * inputKeys() call is routed through, proving it queries the LIVE external
   * source rather than this workflow's own prior output. When declared, the
   * enforcement (T488) asserts that every call to inputKeys() truly goes through
   * that service, never reads back this job's own prior `work_items` output,
   * and handles the service's rate-limit/quota transparently (e.g. a
   * QuotaExceededError soft-fail that defers to the next run). Omit if the job
   * has no inputKeys() or if inputKeys() doesn't route through a service.
   */
  inputKeysService?: string;
  /**
   * PORTS (see `src/engine/ports.ts`). Present, even when empty, on a job made by
   * `defineStage`: that is how the engine tells a ports stage from a plain one
   * (which only the engine's own tests still use). A workflow's stages are all
   * one or the other.
   *
   * `inputs`: what this stage needs, by name. Each is bound at load to the direct
   * dependency (or, for a `many` port, dependencies) that outputs the same artifact.
   * `outputs`: what this stage commits, by name. Each must be committed every run.
   */
  inputs?: Record<string, InputPort>;
  outputs?: Record<string, OutputPort>;
  /** Persistent cross-run state this stage reads or writes: declared for visibility. */
  state?: StateDecl[];
  /** Ledger job names of OTHER workflows this stage reads (declared, checked to exist). */
  reads?: string[];
  /**
   * How to show one of this stage's ledger items on the run page: its title, the
   * fields worth seeing, and a file to preview. Given the item's recorded detail.
   * Without it the row shows `detail.name` and nothing else.
   */
  describeItem?(detail: Record<string, unknown>, itemKey: string): Omit<IoItem, 'id'>;
  /**
   * Marks the stage whose items are the workflow's PRODUCT (what the workflow
   * page's Output section lists) when that is not simply the final stage.
   */
  product?: boolean;
  /**
   * Given what this stage recorded for an item (the `detail` of its successful
   * ledger row): does that result mean NO later stage has anything to do for the
   * item? For example an evaluate stage that decided "nothing to change", when
   * the apply stage after it only ever writes a row for a file it changed.
   *
   * It is consulted in one place: when a LIMITED run picks the first N inputs
   * that still have work. Without it such an item never gets a row in the final
   * stage, so it looks unfinished for ever, and every limited run picks it and
   * does nothing. It is read from the row as it stands when the run starts, so a
   * verdict that changes later (too recent today, eligible next week) is picked
   * up. Unlimited runs never look at it.
   */
  settles?(detail: Record<string, unknown>): boolean;
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
  /** repeatUntilStable cycle (1-based) this run belongs to; null for pre-v2 rows. */
  cycle?: number | null;
  /** Machine-readable reason the run ended as it did (see `OutcomeReason` in the store). */
  outcome_reason?: string | null;
  /** Epoch ms: stage became ready / attempt spawned / attempt settled. */
  queued_at_ms?: number | null;
  started_at_ms?: number | null;
  finished_at_ms?: number | null;
  /** ms spent on inbound gates / input resolution before this run. */
  gate_ms?: number | null;
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
  /**
   * Whether the run-end aggregate push notification (T189) fires for this
   * workflow. Default true. User-editable + code-reconciled from the dashboard
   * (T285) — same shape as `maxConcurrency`/`schedule`.
   */
  notifyEnabled?: boolean;
  /**
   * Grouping label for the workflows-list page. Manifest-owned, code-synced on
   * every sync — unlike `schedule`/`maxConcurrency`/`notifyEnabled` there is NO
   * dashboard edit UI and NO `_overridden` column; a synced row's `category`
   * always tracks the manifest. Omit to default to `'uncategorized'`.
   */
  category?: string;
  /**
   * A short, plain-language sentence explaining HOW this workflow is idempotent
   * (what it tracks, whether/how items get re-evaluated) — for the workflow
   * detail page, so the owner can understand a workflow's idempotency model at
   * a glance without reading its CLAUDE.md or source. Manifest-owned,
   * code-synced on every sync — like `category` there is NO dashboard edit UI
   * and NO `_overridden` column; a synced row's `idempotency_note` always
   * tracks the manifest. Omit/empty to render nothing on the dashboard.
   */
  idempotencyNote?: string;
  /**
   * Workflows this one reads the results of. If any of them has a run in
   * progress when this workflow starts, the run waits (visibly, and cancellably)
   * until they have finished, so it never works from output that is half-way
   * through being rebuilt. It is NOT a trigger: this workflow still starts on its
   * own schedule, and does not care whether the other run succeeded. After
   * `LOCALJOBS_AFTER_MAX_WAIT_MS` it stops waiting and starts anyway.
   */
  after?: string[];
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
  /** Why the run ended, when the status alone does not say (cancel source, restart, unhandled error). */
  end_reason?: string | null;
  /** How many repeatUntilStable cycles actually ran. */
  cycles?: number | null;
  /** The workflow run this one resumed from, if any. */
  resumed_from?: string | null;
}
