// Same-origin by default: the browser fetches `/api/*` from the dashboard's own
// origin, which Next.js rewrites (server-side, in next.config.js) to the loopback
// daemon API. This is what makes the dashboard reachable over a Tailscale tailnet
// without ever exposing the API — a remote browser talks ONLY to the dashboard.
// Override with an absolute base only if you intentionally point the browser at a
// directly-exposed API (then you also need LOCALJOBS_TOKEN + a CORS origin).
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

export type RunStatus =
  | 'running' | 'success' | 'failed' | 'timeout' | 'cancelled' | 'skipped';

export type WorkflowRunStatus = 'running' | 'success' | 'partial' | 'failed' | 'cancelled';

export interface Run {
  id: string;
  job_name: string;
  status: RunStatus;
  trigger: 'schedule' | 'manual';
  attempt: number;
  progress: number;
  progress_msg: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  error: string | null;
  workflow_run_id?: string | null;
  /** repeatUntilStable cycle (1-based) this run belongs to. */
  cycle?: number | null;
  /**
   * Machine-readable reason the run ended as it did, when it is not a plain
   * success or failure of its own process: noop | stalled | upstream-skipped |
   * overlap | gate-failed | not-started-cancelled | orphaned.
   */
  outcome_reason?: string | null;
  queued_at_ms?: number | null;
  started_at_ms?: number | null;
  finished_at_ms?: number | null;
  /** ms spent checking inbound gates / resolving inputs before the stage spawned. */
  gate_ms?: number | null;
}

/** Plain-language explanation of a member run's `outcome_reason`. */
export const OUTCOME_REASON_LABEL: Record<string, string> = {
  noop: 'Ran, but had nothing to do',
  stalled: 'Stalled: had work queued and completed none of it',
  'upstream-skipped': 'Not run',
  overlap: 'Not run',
  'gate-failed': 'Not run, an input check failed',
  'not-started-cancelled': 'Not started',
  orphaned: 'Interrupted by a daemon restart',
};

// A job is only ever a workflow member (T070): schedule, the enable toggle, the
// next-run and run-now all live on the workflow, never the job. The job view is
// read-only — status, run history, logs.
export interface Job {
  name: string;
  description: string;
  timeout_ms: number;
  max_retries: number;
  created_at: string;
  last_run: Run | null;
  stuck: number;
  workflow?: string | null; // set if this job is a workflow member
}

export interface WorkflowMember {
  job_name: string;
  depends_on: string[];
}

export interface WorkflowRun {
  id: string;
  workflow_name: string;
  status: WorkflowRunStatus;
  trigger: string;
  progress: number;
  progress_msg: string;
  /** Manual run-limit: N originating inputs this run was bounded to (T094); null = unlimited. */
  run_limit?: number | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface Workflow {
  name: string;
  description: string;
  schedule: string | null;
  enabled: number;
  /** 1 when the owner has edited the schedule from the dashboard (T135); code-sync then preserves it. */
  schedule_overridden?: number;
  /** Raw user-override of bounded parallelism, or null when not overridden (T169). */
  max_concurrency?: number | null;
  /** 1 when the owner has edited maxConcurrency from the dashboard (T169); code-sync then preserves it. */
  max_concurrency_overridden?: number;
  /** Effective bounded parallelism the next run will use — override / manifest / default (T169).
   *  `0` means unlimited (no cap, all ready stages launch together — T201 sentinel). */
  effective_max_concurrency?: number;
  /** Raw user-override of notify-enabled (0/1), or absent when not set (T285). */
  notify_enabled?: number;
  /** 1 when the owner has edited notifyEnabled from the dashboard (T285); code-sync then preserves it. */
  notify_enabled_overridden?: number;
  /** Effective notify-enabled the next run will use — override / manifest / default true (T285). */
  effective_notify_enabled?: boolean;
  /** Plain user-set "reviewed & settled" flag (T497) — no code/manifest source, toggle-only, purely informational. */
  certified?: number;
  /** True while a manual run is claimed but its workflow_runs row doesn't exist yet — e.g. still
   *  awaiting a slow root-stage inputKeys() crawl (T595). Purely transient; falls back to the
   *  normal last_run display once the real run row appears on the next poll. */
  starting?: boolean;
  created_at: string;
  last_run: WorkflowRun | null;
  next_run: string | null;
  jobs: WorkflowMember[];
  stuck: number;
  /** True when a member declares input keys — only then can a manual run be limited (T094). */
  limitable?: boolean;
  /** Structural gates derived from member job contracts; present on the detail endpoint. */
  gates?: StructuralGate[];
  runs?: WorkflowRun[];
}

/** A validation gate on the workflow graph — structural only, no run state. */
export interface StructuralGate {
  key: string;
  producer: string;
  consumer: string;
  description?: string | null;
}

/** A validation gate's state within one workflow run (derived from member runs). */
export interface GateStatus {
  key: string;
  producer: string;
  consumer: string;
  state: 'passed' | 'failed' | 'pending';
  /** What the gate's contracts assert (producer/consumer contract descriptions). */
  description?: string | null;
  /** When `state === 'failed'`, the member run id to link to its failure logs. */
  failureRunId?: string | null;
}

/** One plain-English expectation a contract asserts about its artifact. */
export interface ShapeExpectation {
  label: string;
  detail?: string;
}

/** The expected shape of an artifact, as declared by a contract (for display). */
export interface ArtifactShape {
  summary: string;
  format?: string;
  expectations: ShapeExpectation[];
}

/** Pass/fail for one expectation against the ACTUAL artifact that flowed. */
export interface ExpectationResult {
  label: string;
  ok: boolean;
  actual?: string;
}

/** Outcome of running a contract's check against the real artifact. */
export interface GateResult {
  ok: boolean;
  violations?: string[];
  detail?: string;
  checks?: ExpectationResult[];
  sample?: string;
}

/** One side (produced/consumed) of a gate: the declared shape + a live check result. */
export interface GateSide {
  shape: ArtifactShape | null;
  result: GateResult | null;
}

/** Full inspection of a single gate: classified state + expected-vs-actual sides. */
export interface GateInspection {
  gate: GateStatus;
  produced: GateSide | null;
  consumed: GateSide | null;
  /** True when both sides declare the SAME contract shape (T138) — the page then
   *  collapses the duplicated producer/consumer panels into one. False for an
   *  asymmetric gate (different produces[key] vs consumes[key] shapes) or when a
   *  side has no declared shape. */
  identical: boolean;
  /**
   * Set when the result shown is what the engine RECORDED when it checked this
   * boundary during the run. Null means there was no record (an older run, or a
   * boundary the run never reached) and the artifact was checked as it is on disk
   * now, which may reflect a later run.
   */
  recorded?: { at: number; source: 'ports' | 'gate'; fresh?: boolean; note?: string | null } | null;
}

/** One side (produced/consumed) of a gate's DEFINITION-level view: declared shape
 *  only, no run actuals. */
export interface GateShapeSide {
  shape: ArtifactShape | null;
}

/** Run-AGNOSTIC, definition-level inspection of a gate (from the workflow
 *  definition view): the structural gate + each side's declared expected shape.
 *  No run state, no actuals — purely what the contract asserts. */
export interface StructuralGateDetail {
  gate: StructuralGate;
  produced: GateShapeSide | null;
  consumed: GateShapeSide | null;
  /** True when both sides declare the SAME contract shape (T138) — the definition
   *  page then collapses to one panel; false for an asymmetric gate / absent shape. */
  identical: boolean;
}

/**
 * One display row: an item a stage read or wrote. The SERVER decides the title,
 * the fields worth showing and the file to preview (from the stage's own
 * `describeItem`, or its artifact type's `items`); the dashboard renders it as
 * given and infers nothing from raw ledger detail.
 */
export interface IoItem {
  id: string;
  title: string;
  subtitle?: string;
  status?: string;
  fields?: { label: string; value: string }[];
  preview?: { path: string; format: string };
}

/** A ledger item row in a stage's Inputs or Outputs list. */
export interface StageIoItem extends IoItem {
  jobName: string;
  itemKey: string;
}

/** The recorded result of a check (a gate, or an artifact's own check at commit). */
export interface RecordedCheck {
  ok: boolean;
  violations?: string[];
  detail?: string;
  sample?: string;
  checks?: { label: string; ok: boolean; actual?: string }[];
}

/**
 * One artifact a stage was handed (an input) or committed (an output) during a
 * run: a file, a directory, ledger rows, or a small inline value. Recorded by the
 * engine when it happened, so it describes THIS run.
 */
export interface StageIoArtifact {
  id: number;
  /** The stage that committed it. */
  job: string;
  port: string;
  artifactKey: string;
  description: string | null;
  storage: string;
  format: string | null;
  ok: boolean;
  /** False when the producer carried the previous artifact forward unchanged. */
  fresh: boolean;
  note: string | null;
  summary: string | null;
  itemCount: number | null;
  bytes: number | null;
  committedAtMs: number;
  preview: { path: string; format: string } | null;
  inline?: unknown;
  sample: IoItem[];
  check: RecordedCheck | null;
  /** The workflow run that committed it (set where a card is shown outside its run page). */
  workflowRunId?: string;
  /** Inputs only. */
  consumerPort?: string;
  resolved?: { ok: boolean; reason: string | null };
  used?: { total: number; items: IoItem[] };
}

/**
 * Response from GET /api/workflow-runs/:id/stage-io?job=<job> (or `overall=true`).
 * Two independent, un-paired sides. Each side has the ARTIFACTS the stage was
 * handed / committed (ports runs) and the ledger ITEMS it worked on / changed.
 * `mode` says how the run was recorded: 'ports' is derived from the engine's own
 * record; 'legacy' is the older ledger-only view (no artifacts).
 */
export interface StageIo {
  inputs: StageIoItem[];
  outputs: StageIoItem[];
  /** Per-side totals independent of paging (optional: absent from pre-paging fixtures). */
  inputTotal?: number;
  outputTotal?: number;
  predecessorJobs: string[];
  /** The stages (or legacy ledger names) whose rows are the outputs. */
  outputJobs?: string[];
  job: string;
  mode?: 'ports' | 'legacy';
  inputArtifacts?: StageIoArtifact[];
  outputArtifacts?: StageIoArtifact[];
  /** Items the stage re-recorded this run without changing (counted, not listed). */
  outputsUnchanged?: number;
}

/** Paging for the stage-io endpoint — the panel lazy-loads pages of PAGE_SIZE per side. */
export interface StageIoPageParams {
  limit?: number;
  inputsOffset?: number;
  outputsOffset?: number;
}

/** The workflow-wide ("Overall") variant: same shape as `StageIo`. */
export type StageIoOverall = StageIo;

/** Response from GET /api/workflow-runs/:id/artifact-items: one page of an artifact's items. */
export interface ArtifactItemsPage {
  found: boolean;
  items: IoItem[];
  total: number;
  /** The file behind the artifact was rewritten after this run committed it. */
  changedSinceRun: boolean;
  /** Only the sample stored at commit time is available (not the full list). */
  sampleOnly: boolean;
  limit: number;
}

/** Response from GET /api/workflow-runs/:id/output (T110) — a job's produced
 *  markdown artifact for one work item. `found` is false when the item has no
 *  recorded/accessible markdown (so the UI falls back to showing the key). */
export interface WorkflowRunOutput {
  found: boolean;
  /** Present when fetched for a ledger item; absent for a preview by path. */
  job?: string;
  key?: string;
  /** The item's declared render form (T262/T282) — 'markdown' when unset. */
  format?: string;
  file?: string;
  bytes?: number;
  truncated?: boolean;
  content?: string;
}

export interface Service {
  name: string;
  description: string;
  category: string;
  rate_per_minute: number | null;
  daily_cap: number | null;
  monthly_cap: number | null;
  timeout_ms: number | null;
  paid: number;
  limits_overridden: number;
  rate_limit_source: string;
  used_today: number;
  used_month: number;
  rate_last_min: number;
}

export interface ServiceLimits {
  rate_per_minute: number | null;
  daily_cap: number | null;
  monthly_cap: number | null;
  timeout_ms: number | null;
}

export interface ServiceConsumerGroup {
  workflow_name: string | null;
  jobs: { job_name: string; last_used: string }[];
}

export interface StuckItem {
  job_name: string;
  item_key: string;
  attempts: number;
  detail: {
    name?: string;
    error?: string;
    status?: string;
    // richer fetch diagnostics (perfumes-fetch)
    pageTitle?: string;
    snippet?: string;
    debugFile?: string;
    finalUrl?: string;
    textLength?: number;
    httpStatus?: number | null;
    url?: string;
  } | null;
  updated_at: string;
}

export interface LogLine {
  id: number;
  ts: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

/** One line from the global cross-cutting log feed (T311/T312) — merges
 *  per-job run_logs and per-workflow workflow_run_logs, newest first. */
export interface GlobalLogLine {
  id: number;
  ts: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  source: 'job' | 'workflow';
  jobName: string | null;
  workflowName: string | null;
  runId: string | null;
  workflowRunId: string | null;
}

/** One complete-missing TV season (plex workflow), overlaid with ledger status. */
export interface MissingSeason {
  tmdbId: number;
  title: string;
  year: number | null;
  season: number;
  tmdbStatus: string;
  notified: boolean;
  ignored: boolean;
}

export interface MissingSeasons {
  generatedAt: string | null;
  shows: MissingSeason[];
}

/** One recommendation (TV recs workflow), overlaid with ledger status. */
export interface TvRec {
  tmdbId: number;
  title: string;
  year: number | null;
  reason: string;
  lens: string;
  genre: string;
  tmdbRating: number | null;
  /** Already digest-notified — true once announced. */
  notified: boolean;
  /** Owner manually suppressed it — excluded from future reports + notifications. */
  ignored: boolean;
}

export interface TvRecs {
  generatedAt: string | null;
  pooled: number;
  recommendations: TvRec[];
}

/** One recommendation (movies workflow), overlaid with ledger status. */
export interface MovieRec {
  tmdbId: number;
  title: string;
  year: number | null;
  reason: string;
  lens: string;
  genre: string;
  tmdbRating: number | null;
  /** Already digest-notified — true once announced. */
  notified: boolean;
  /** Owner manually suppressed it — excluded from future reports + notifications. */
  ignored: boolean;
}

export interface MovieRecs {
  generatedAt: string | null;
  pooled: number;
  recommendations: MovieRec[];
}

/** One detected franchise gap (movies workflow), overlaid with ledger status. */
export interface MovieGap {
  collectionId: number;
  collectionName: string;
  tmdbId: number;
  title: string;
  year: number | null;
  /** TMDB vote_average (0–10) — owner CONTEXT only; never used to hide a gap. */
  tmdbRating: number | null;
  /** Already digest-notified (deduped) — true once announced. */
  notified: boolean;
  /** Owner manually suppressed it — excluded from future reports + notifications. */
  ignored: boolean;
}

export interface MovieGaps {
  generatedAt: string | null;
  collectionsChecked: number;
  gaps: MovieGap[];
  /** Owned example film per collection name (from franchise-gaps.json). */
  collectionExamples: Record<string, { title: string; year: number | null }>;
}

/** One terminal-stage output item from the unified workflow output section (T205). */
export interface WorkflowOutputItem {
  jobName: string;
  itemKey: string;
  /** Human-readable name from detail.name, if the job recorded one. */
  name: string | null;
  /** True when the work item has a markdown artifact path in detail.markdown. */
  hasMarkdown: boolean;
  /**
   * True when the item has ANY viewable output artifact (T616) — a legacy
   * `detail.markdown` path, or the newer T262 output form (`detail.format` +
   * `detail.path`, e.g. a JSON artifact). Use this, not `hasMarkdown`, to decide
   * whether to show a "View" button — the backend output endpoint already
   * serves both forms.
   */
  viewable: boolean;
  updatedAt: string;
}

export interface WorkflowOutputItems {
  items: WorkflowOutputItem[];
  /** Total success items independent of paging (optional: absent from pre-paging fixtures). */
  total?: number;
  terminalJobs: string[];
  /**
   * For a ports workflow: the latest artifact each output of its product stage
   * committed, in any run (what the workflow's product looks like right now).
   * Empty or absent for a legacy workflow.
   */
  artifacts?: StageIoArtifact[];
}

/** Scope for bulk stuck-item operations passed to the bulk API endpoints. */
export type BulkScope =
  | { type: 'all' }
  | { type: 'job'; job: string }
  | { type: 'workflow'; workflow: string };

/** Builds a query string from a params object, omitting undefined/empty values. */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    usp.set(k, String(v));
  }
  return usp.toString();
}

function scopeBody(scope: BulkScope): Record<string, string> {
  if (scope.type === 'all') return { scope: 'all' };
  if (scope.type === 'job') return { scope: 'job', job: scope.job };
  return { scope: 'workflow', workflow: scope.workflow };
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

/** Build the &limit=&inputsOffset=&outputsOffset= tail for the stage-io endpoint. */
function stageIoPageQuery(page?: StageIoPageParams): string {
  if (!page) return '';
  const parts: string[] = [];
  if (page.limit !== undefined) parts.push(`limit=${page.limit}`);
  if (page.inputsOffset !== undefined) parts.push(`inputsOffset=${page.inputsOffset}`);
  if (page.outputsOffset !== undefined) parts.push(`outputsOffset=${page.outputsOffset}`);
  return parts.length ? `&${parts.join('&')}` : '';
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

/** Like `post`, but surfaces the server's JSON `{ error }` body (a 400 validation
 *  message) as the thrown Error instead of a generic status-text message — used
 *  by the workflow/job settings editors (schedule, concurrency, notify, certified,
 *  timeout) so the page can show the server's real validation reason inline. */
async function postWithServerError<T extends Record<string, unknown>>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export const api = {
  jobs: () => get<{ jobs: Job[] }>('/api/jobs'),
  job: (name: string) => get<{ job: Job }>(`/api/jobs/${encodeURIComponent(name)}`),
  jobRuns: (name: string) => get<{ runs: Run[] }>(`/api/jobs/${encodeURIComponent(name)}/runs`),
  recentRuns: (limit = 50) => get<{ runs: Run[] }>(`/api/runs?limit=${limit}`),
  run: (id: string, after = 0) => get<{ run: Run; logs: LogLine[] }>(`/api/runs/${id}?after=${after}`),
  // No runNow/toggle for a job (T070): you run + enable a WORKFLOW, never a job.
  stuck: (job?: string) => get<{ stuck: StuckItem[] }>(`/api/stuck${job ? `?job=${encodeURIComponent(job)}` : ''}`),
  stuckForWorkflow: (workflow: string) => get<{ stuck: StuckItem[] }>(`/api/stuck?workflow=${encodeURIComponent(workflow)}`),
  ignored: (job?: string) => get<{ ignored: StuckItem[] }>(`/api/ignored${job ? `?job=${encodeURIComponent(job)}` : ''}`),
  unstick: (job: string, key: string) => post<{ ok: boolean; unstuck: number }>(`/api/stuck/unstick`, { job, key }),
  ignore: (job: string, key: string) => post<{ ok: boolean; ignored: number }>(`/api/stuck/ignore`, { job, key }),
  unstickBulk: (scope?: BulkScope) => post<{ ok: boolean; unstuck: number }>('/api/stuck/unstick-bulk', scope ? scopeBody(scope) : {}),
  ignoreBulk: (scope?: BulkScope) => post<{ ok: boolean; ignored: number }>('/api/stuck/ignore-bulk', scope ? scopeBody(scope) : {}),

  // TV-seasons missing-season audit: list current gaps + manually ignore one (T179).
  missingSeasons: () => get<MissingSeasons>('/api/missing-seasons'),
  missingSeasonsIgnore: (tmdbId: number, season: number) =>
    post<{ ok: boolean; ignored: number }>(`/api/missing-seasons/${tmdbId}/${season}/ignore`),
  missingSeasonsIgnoreBulk: (items: { tmdbId: number; season: number }[]) =>
    post<{ ok: boolean; ignored: number }>('/api/missing-seasons/ignore-bulk', { items }),
  unignoreMissingSeason: (tmdbId: number, season: number) =>
    post<{ ok: boolean; unignored: number }>(`/api/missing-seasons/${tmdbId}/${season}/unignore`),
  missingSeasonsUnignoreBulk: (items: { tmdbId: number; season: number }[]) =>
    post<{ ok: boolean; unignored: number }>('/api/missing-seasons/unignore-bulk', { items }),

  // Movies franchise-gap audit: list current gaps + manually ignore one (T145).
  movieGaps: () => get<MovieGaps>('/api/movie-gaps'),
  ignoreMovieGap: (tmdbId: number) =>
    post<{ ok: boolean; ignored: number }>(`/api/movie-gaps/${tmdbId}/ignore`),
  ignoreMovieGapBulk: (tmdbIds: number[]) =>
    post<{ ok: boolean; ignored: number }>('/api/movie-gaps/ignore-bulk', { tmdbIds }),
  unignoreMovieGap: (tmdbId: number) =>
    post<{ ok: boolean; unignored: number }>(`/api/movie-gaps/${tmdbId}/unignore`),
  unignoreMovieGapBulk: (tmdbIds: number[]) =>
    post<{ ok: boolean; unignored: number }>('/api/movie-gaps/unignore-bulk', { tmdbIds }),

  // Movies recommendations: list current recs + manually ignore one (T209).
  movieRecs: () => get<MovieRecs>('/api/movie-recs'),
  ignoreMovieRec: (tmdbId: number) =>
    post<{ ok: boolean; ignored: number }>(`/api/movie-recs/${tmdbId}/ignore`),
  unignoreMovieRec: (tmdbId: number) =>
    post<{ ok: boolean; unignored: number }>(`/api/movie-recs/${tmdbId}/unignore`),
  unignoreMovieRecBulk: (tmdbIds: number[]) =>
    post<{ ok: boolean; unignored: number }>('/api/movie-recs/unignore-bulk', { tmdbIds }),

  // TV recommendations: list current recs + manually ignore one (T219).
  tvRecs: () => get<TvRecs>('/api/tv-recs'),
  ignoreTvRec: (tmdbId: number) =>
    post<{ ok: boolean; ignored: number }>(`/api/tv-recs/${tmdbId}/ignore`),
  unignoreTvRec: (tmdbId: number) =>
    post<{ ok: boolean; unignored: number }>(`/api/tv-recs/${tmdbId}/unignore`),
  unignoreTvRecBulk: (tmdbIds: number[]) =>
    post<{ ok: boolean; unignored: number }>('/api/tv-recs/unignore-bulk', { tmdbIds }),

  // Global cross-cutting log feed (T311/T312): merges every job + workflow run's
  // logs, newest first. `level` is a comma-joined subset of info/warn/error (omit
  // for all levels); `job`/`workflow` are mutually exclusive scope filters.
  globalLogs: (params: {
    level?: string;
    job?: string;
    workflow?: string;
    q?: string;
    windowHours?: number;
    before?: string;
    limit?: number;
  }) =>
    get<{ logs: GlobalLogLine[]; nextCursor: string | null }>(`/api/logs?${buildQuery(params)}`),

  recentWorkflowRuns: (limit = 50) => get<{ runs: WorkflowRun[] }>(`/api/workflow-runs?limit=${limit}`),
  workflows: () => get<{ workflows: Workflow[] }>('/api/workflows'),
  workflow: (name: string) => get<{ workflow: Workflow }>(`/api/workflows/${encodeURIComponent(name)}`),
  workflowRun: (id: string, after = 0) =>
    get<{ run: WorkflowRun; jobs: Run[]; logs: LogLine[]; gates: GateStatus[] }>(
      `/api/workflow-runs/${id}?after=${after}`,
    ),
  gateInspection: (id: string, producer: string, key: string) =>
    get<GateInspection>(
      `/api/workflow-runs/${id}/gates/${encodeURIComponent(producer)}/${encodeURIComponent(key)}`,
    ),
  workflowGate: (name: string, producer: string, key: string) =>
    get<StructuralGateDetail>(
      `/api/workflows/${encodeURIComponent(name)}/gates/${encodeURIComponent(producer)}/${encodeURIComponent(key)}`,
    ),
  workflowRunStageIo: (id: string, job: string, page?: StageIoPageParams) =>
    get<StageIo>(`/api/workflow-runs/${id}/stage-io?job=${encodeURIComponent(job)}${stageIoPageQuery(page)}`),
  workflowRunStageIoOverall: (id: string, page?: StageIoPageParams) =>
    get<StageIoOverall>(`/api/workflow-runs/${id}/stage-io?overall=true${stageIoPageQuery(page)}`),
  workflowRunArtifactItems: (id: string, artifactId: number, page?: { limit?: number; offset?: number }) =>
    get<ArtifactItemsPage>(
      `/api/workflow-runs/${id}/artifact-items?artifact=${artifactId}&limit=${page?.limit ?? 100}&offset=${page?.offset ?? 0}`,
    ),
  // Preview ONE produced file by its recorded path (server-side guarded to data/out/).
  outputFile: (path: string, format: string) =>
    get<WorkflowRunOutput>(`/api/output-file?path=${encodeURIComponent(path)}&format=${encodeURIComponent(format)}`),
  workflowRunOutput: (id: string, job: string, key: string) =>
    get<WorkflowRunOutput>(
      `/api/workflow-runs/${id}/output?job=${encodeURIComponent(job)}&key=${encodeURIComponent(key)}`,
    ),
  // T205: unified output section — terminal-stage work items for a workflow.
  workflowOutputItems: (name: string, page?: { limit?: number; offset?: number }) =>
    get<WorkflowOutputItems>(
      `/api/workflows/${encodeURIComponent(name)}/output-items?limit=${page?.limit ?? 100}&offset=${page?.offset ?? 0}`,
    ),
  // T205: markdown artifact for one output item (not scoped to a specific run).
  workflowOutput: (name: string, job: string, key: string) =>
    get<WorkflowRunOutput>(
      `/api/workflows/${encodeURIComponent(name)}/output?job=${encodeURIComponent(job)}&key=${encodeURIComponent(key)}`,
    ),
  // Surfaces the server's error body as the thrown message so the page can show it
  // inline — notably the 409 "… already has an active run" when a run is in progress
  // (otherwise a rejected Run click looks like it silently did nothing).
  runWorkflow: (name: string, limit?: number) =>
    postWithServerError<{ ok: boolean; limit: number | null }>(
      `/api/workflows/${encodeURIComponent(name)}/run`,
      limit !== undefined ? { limit } : {},
    ),
  toggleWorkflow: (name: string, enabled: boolean) => post<{ ok: boolean }>(`/api/workflows/${encodeURIComponent(name)}/toggle`, { enabled }),
  // Persist + live-apply a user override of a workflow's cron schedule (T135). An
  // empty string clears it to manual-only. Surfaces the server's 400 validation
  // error (its `error` body) as the thrown message so the page can show it inline.
  updateWorkflowSchedule: (name: string, schedule: string) =>
    postWithServerError<{ ok: boolean; schedule: string | null; next_run: string | null }>(
      `/api/workflows/${encodeURIComponent(name)}/schedule`,
      { schedule },
    ),
  // Persist a user override of a workflow's bounded-parallelism cap (T169). Takes
  // effect on the NEXT run (no daemon restart). Surfaces the server's 400 validation
  // error as the thrown message so the page can show it inline.
  updateWorkflowConcurrency: (name: string, maxConcurrency: number) =>
    postWithServerError<{ ok: boolean; max_concurrency: number }>(
      `/api/workflows/${encodeURIComponent(name)}/concurrency`,
      { maxConcurrency },
    ),
  // Persist a user override of whether a workflow sends its run-end push
  // notification (T285). Takes effect on the NEXT run (no daemon restart).
  updateWorkflowNotify: (name: string, notifyEnabled: boolean) =>
    postWithServerError<{ ok: boolean; notify_enabled: boolean }>(
      `/api/workflows/${encodeURIComponent(name)}/notify`,
      { notifyEnabled },
    ),
  // Persist a plain user-set "certified" flag on a workflow (T497) — no
  // code/manifest source, so this is a toggle-only, purely informational setting.
  updateWorkflowCertified: (name: string, certified: boolean) =>
    postWithServerError<{ ok: boolean; certified: boolean }>(
      `/api/workflows/${encodeURIComponent(name)}/certify`,
      { certified },
    ),
  // Persist a user override of a job's timeoutMs (T297) — mirrors
  // updateWorkflowSchedule/updateWorkflowConcurrency, but scoped to a job row.
  // The API stays in milliseconds; the caller converts from the seconds shown in
  // the UI. Surfaces the server's 400 validation error as the thrown message.
  updateJobTimeout: (name: string, timeoutMs: number) =>
    postWithServerError<{ ok: boolean; job: { timeout_ms: number } }>(
      `/api/jobs/${encodeURIComponent(name)}/timeout`,
      { timeoutMs },
    ),
  cancelWorkflowRun: (id: string) => post<{ ok: boolean }>(`/api/workflow-runs/${id}/cancel`),
  // Clear all output data for a workflow (T203): work_items + runs/logs + data/out/*.
  // Preserves: input data (data/raw), chrome-profile, settings, definition tables.
  // Refuses while the workflow has an active run.
  resetWorkflowOutput: (name: string) =>
    post<{ ok: boolean; jobNames: string[]; itemsDeleted: number; runsDeleted: number; wfRunsDeleted: number; filesRemoved: number; outDir: string | null }>(
      `/api/workflows/${encodeURIComponent(name)}/reset-output`,
    ),
  // Bulk variant of resetWorkflowOutput (T322): runs the same reset across EVERY
  // workflow in one call. Workflows with an active run are ALWAYS skipped; a
  // certified workflow is skipped too UNLESS `force` is true, which bypasses the
  // certification guard (the active-run guard is never bypassed).
  resetAllWorkflowsOutput: (force = false) =>
    post<{
      ok: boolean;
      forced: boolean;
      totalWorkflows: number;
      resetCount: number;
      skippedCount: number;
      results: Array<
        | { name: string; status: 'reset'; certified: boolean; itemsDeleted: number; runsDeleted: number; wfRunsDeleted: number; filesRemoved: number; outDir: string | null }
        | { name: string; status: 'skipped'; reason: string }
      >;
    }>('/api/workflows/reset-output-all', { force }),
  // Service response cache (T451/T478) — read-only per-service row counts.
  serviceCacheCounts: () => get<{ counts: Array<{ service_name: string; count: number }> }>('/api/cache'),
  // Individual service_cache rows (T610/T611) — optionally scoped to one service.
  // `live` is computed server-side against that service's configured cacheTtlMs.
  serviceCacheRows: (service?: string) =>
    get<{ rows: Array<{ service_name: string; cache_key: string; cached_at: string; response_json: string; live: boolean }> }>(
      '/api/cache/rows' + (service ? `?service=${encodeURIComponent(service)}` : ''),
    ),
  // Clear service_cache rows — all services, or one when serviceName is given.
  // Distinct from resetWorkflowOutput/resetAllWorkflowsOutput above, which never
  // touch service_cache.
  clearServiceCache: (serviceName?: string) =>
    post<{ ok: boolean; cleared: number }>('/api/cache/clear', serviceName ? { serviceName } : {}),
  // Fleet-wide "run everything" sweep (T396): fires a manual run of every
  // workflow (including disabled ones), defaulting non-limited runs to `limit`
  // originating inputs for workflows that support limiting (default 3). Fire-
  // and-forget per workflow — the response is dispatched, not settled.
  runAllWorkflows: (limit?: number) =>
    post<{
      ok: boolean;
      totalWorkflows: number;
      startedCount: number;
      skippedCount: number;
      limit: number;
      results: Array<
        | { name: string; status: 'started'; limited: boolean; limit: number | null }
        | { name: string; status: 'skipped'; reason: string }
      >;
    }>('/api/workflows/run-all', limit !== undefined ? { limit } : undefined),
  services: () => get<{ services: Service[] }>('/api/services'),
  updateServiceLimits: (name: string, limits: ServiceLimits) =>
    post<{ ok: boolean; service: Service }>(`/api/services/${name}/limits`, limits),
  serviceConsumers: (name: string) =>
    get<{ consumers: ServiceConsumerGroup[] }>(`/api/services/${name}/consumers`),

};
