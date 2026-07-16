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
   * Override which `work_items` job_name the unified Output section (T205) AND
   * the run-scoped Stage I/O panel (`GET /workflow-runs/:id/stage-io`, T603)
   * read from, for a workflow whose DAG terminal stage doesn't record its ledger
   * rows under its own DAG member name. Two shapes in use:
   *  - Names an EXISTING member job of this workflow (stocks-sync-style): the
   *    true DAG terminal stage (e.g. `stocks-notify`) is a pure notify-trigger
   *    with no ledger of its own, so both surfaces read an EARLIER stage's
   *    ledger (`stocks-snapshot`) instead.
   *  - Names a DECOUPLED ledger job_name that ISN'T a DAG member at all
   *    (movie-recs/tv-recs-style, T603): the terminal notify stage (e.g.
   *    `movie-recs-notify`) genuinely records its own "have I notified this?"
   *    ledger, but under a shared cross-domain keyspace name (`movie-recs`)
   *    rather than its own DAG member name — so a lookup by the literal member
   *    name would always come back empty.
   * When unset (the common case), both surfaces read the DAG's terminal wave
   * (or, for a per-stage Stage I/O lookup, the requested stage's own name),
   * exactly as before.
   */
  outputJob?: string;
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
  /** Grouping label for the Services dashboard page. Controlled values:
   *  'cli-tool' | 'website-scrape' | 'api'. Omit to fall back to 'uncategorized'.
   *  Manifest-owned only — no dashboard edit UI, refreshed from code on every sync. */
  category?: string;
  /** Where this service's rate/quota numbers (ratePerMinute/dailyCap/monthlyCap/minIntervalMs) came
   *  from — a documented API limits page (name + link when one exists), an empirical/observed
   *  estimate from testing, or an explicit conservative guess when nothing is published. Write this
   *  HONESTLY: say "documented at <url>" only when you can point at a real page stating the number;
   *  otherwise say so plainly ("no public rate-limit docs found; empirically tuned" / "no published
   *  limit; conservative estimate"). Manifest-owned only — no dashboard edit UI, refreshed from code
   *  on every sync, exactly like `category`. */
  rateLimitSource?: string;
  /** Code default for this service's per-call request/process timeout (ms). Unlike
   *  ratePerMinute/dailyCap/monthlyCap — enforced generically inside `callService` —
   *  a timeout must actually CANCEL in-flight work, so it is NOT enforced there;
   *  each service's own client code reads the effective value via
   *  `effectiveServiceTimeoutMs(name, fallbackMs)` (`src/core/services.ts`) at its
   *  real request/process-level timeout point. Dashboard-editable + code-reconciled
   *  via the same `limits_overridden` flag as the other limit fields (see
   *  `updateServiceLimits`/`syncService` in `src/db/store.ts`). Omit for "no code
   *  default" — the caller's own fallback then applies. */
  timeoutMs?: number;
  /** Code-level cache TTL (ms) for 'api'-category services opting into response
   *  caching via `cacheKey` in CallServiceOpts. Like `minIntervalMs`/`maxJitterMs`,
   *  this is code-only, not dashboard-editable. Falls back to `SERVICE_CACHE_TTL_MS`
   *  (currently 5 minutes) when unset. Use for services with slower/expensive
   *  operations whose results change infrequently (e.g. Plex library metadata,
   *  TMDB lookups). */
  cacheTtlMs?: number;
}
