// Same-origin by default: the browser fetches `/api/*` from the dashboard's own
// origin, which Next.js rewrites (server-side, in next.config.js) to the loopback
// daemon API. This is what makes the dashboard reachable over a Tailscale tailnet
// without ever exposing the API — a remote browser talks ONLY to the dashboard.
// Override with an absolute base only if you intentionally point the browser at a
// directly-exposed API (then you also need LOCALJOBS_TOKEN + a CORS origin).
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

export type RunStatus =
  | 'queued' | 'running' | 'success' | 'failed' | 'timeout' | 'cancelled' | 'skipped';

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
}

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

/** One row in the run-scoped input→output mapping for a workflow run (T095, T139). */
export interface IoRow {
  inputJob: string;
  inputKey: string;
  inputStatus: string;
  /** Arbitrary JSON detail recorded by the job; may contain `name` for display. */
  inputDetail: Record<string, unknown> | null;
  outputJob: string | null;
  outputKey: string | null;
  outputStatus: string | null;
  outputDetail: Record<string, unknown> | null;
}

/** Response from GET /api/workflow-runs/:id/io */
export interface WorkflowIo {
  io: IoRow[];
  firstWave: string[];
  lastWave: string[];
  /** True when the rows are scoped to the items THIS run advanced (T139). */
  scoped: boolean;
  /**
   * Why the mapping is empty when not scoped (T139): `no-new` = this run advanced
   * nothing new; `pre-feature` = an old run created before per-run IO was recorded.
   */
  emptyReason: 'no-new' | 'pre-feature' | null;
  note: string;
}

/** Response from GET /api/workflow-runs/:id/output (T110) — a job's produced
 *  markdown artifact for one work item. `found` is false when the item has no
 *  recorded/accessible markdown (so the UI falls back to showing the key). */
export interface WorkflowRunOutput {
  found: boolean;
  job: string;
  key: string;
  file?: string;
  bytes?: number;
  truncated?: boolean;
  content?: string;
}

export interface Service {
  name: string;
  description: string;
  rate_per_minute: number | null;
  daily_cap: number | null;
  monthly_cap: number | null;
  paid: number;
  limits_overridden: number;
  used_today: number;
  used_month: number;
  rate_last_min: number;
}

export interface ServiceLimits {
  rate_per_minute: number | null;
  daily_cap: number | null;
  monthly_cap: number | null;
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

export interface TablePage {
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

export interface CannedQueryMeta {
  id: string;
  title: string;
  description: string;
}

export interface CannedQueryResult extends CannedQueryMeta {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface EscalationRung {
  model?: string;
  effort?: string;
}

export interface BacklogDefaults {
  model?: string;
  effort?: string;
  escalation?: EscalationRung[];
}

export interface BacklogTask {
  id: string;
  title: string;
  status: string;
  gate: null | 'gate' | 'needs-human';
  dependsOn: string[];
  tags?: string[];
  model?: string;
  effort?: string;
  escalation?: EscalationRung[];
  scope?: string[];
  verify?: string[];
  // The task's do/doneWhen live in a per-task Markdown spec (T131): `spec` is the
  // repo-relative path (.harness/tasks/TNNN.md) and `specContent` is its inlined
  // text (## Do / ## Done when), supplied by GET /api/backlog for rendering.
  spec?: string;
  specContent?: string;
  // Human-review flag (T124): owner-set via the dashboard, not the harness loop.
  // Defaults to false (the API normalises absent values).
  reviewed?: boolean;
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
}

/** Scope for bulk stuck-item operations passed to the bulk API endpoints. */
export type BulkScope =
  | { type: 'all' }
  | { type: 'job'; job: string }
  | { type: 'workflow'; workflow: string };

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

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  jobs: () => get<{ jobs: Job[] }>('/api/jobs'),
  job: (name: string) => get<{ job: Job }>(`/api/jobs/${name}`),
  jobRuns: (name: string) => get<{ runs: Run[] }>(`/api/jobs/${name}/runs`),
  recentRuns: (limit = 50) => get<{ runs: Run[] }>(`/api/runs?limit=${limit}`),
  run: (id: string, after = 0) => get<{ run: Run; logs: LogLine[] }>(`/api/runs/${id}?after=${after}`),
  // No runNow/toggle for a job (T070): you run + enable a WORKFLOW, never a job.
  stuck: (job?: string) => get<{ stuck: StuckItem[] }>(`/api/stuck${job ? `?job=${job}` : ''}`),
  stuckForWorkflow: (workflow: string) => get<{ stuck: StuckItem[] }>(`/api/stuck?workflow=${encodeURIComponent(workflow)}`),
  ignored: (job?: string) => get<{ ignored: StuckItem[] }>(`/api/ignored${job ? `?job=${job}` : ''}`),
  unstick: (job: string, key: string) => post<{ ok: boolean; unstuck: number }>(`/api/stuck/unstick`, { job, key }),
  ignore: (job: string, key: string) => post<{ ok: boolean; ignored: number }>(`/api/stuck/ignore`, { job, key }),
  unstickBulk: (scope?: BulkScope) => post<{ ok: boolean; unstuck: number }>('/api/stuck/unstick-bulk', scope ? scopeBody(scope) : {}),
  ignoreBulk: (scope?: BulkScope) => post<{ ok: boolean; ignored: number }>('/api/stuck/ignore-bulk', scope ? scopeBody(scope) : {}),

  // Movies franchise-gap audit: list current gaps + manually ignore one (T145).
  movieGaps: () => get<MovieGaps>('/api/movie-gaps'),
  ignoreMovieGap: (tmdbId: number) =>
    post<{ ok: boolean; ignored: number }>(`/api/movie-gaps/${tmdbId}/ignore`),

  recentWorkflowRuns: (limit = 50) => get<{ runs: WorkflowRun[] }>(`/api/workflow-runs?limit=${limit}`),
  workflows: () => get<{ workflows: Workflow[] }>('/api/workflows'),
  workflow: (name: string) => get<{ workflow: Workflow }>(`/api/workflows/${name}`),
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
  workflowRunIo: (id: string) => get<WorkflowIo>(`/api/workflow-runs/${id}/io`),
  workflowRunOutput: (id: string, job: string, key: string) =>
    get<WorkflowRunOutput>(
      `/api/workflow-runs/${id}/output?job=${encodeURIComponent(job)}&key=${encodeURIComponent(key)}`,
    ),
  runWorkflow: (name: string, limit?: number) =>
    post<{ ok: boolean; limit: number | null }>(`/api/workflows/${name}/run`, limit !== undefined ? { limit } : undefined),
  toggleWorkflow: (name: string, enabled: boolean) => post<{ ok: boolean }>(`/api/workflows/${name}/toggle`, { enabled }),
  // Persist + live-apply a user override of a workflow's cron schedule (T135). An
  // empty string clears it to manual-only. Surfaces the server's 400 validation
  // error (its `error` body) as the thrown message so the page can show it inline.
  updateWorkflowSchedule: async (name: string, schedule: string) => {
    const res = await fetch(`${API_BASE}/api/workflows/${encodeURIComponent(name)}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; schedule?: string | null; next_run?: string | null };
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data as { ok: boolean; schedule: string | null; next_run: string | null };
  },
  cancelWorkflowRun: (id: string) => post<{ ok: boolean }>(`/api/workflow-runs/${id}/cancel`),
  services: () => get<{ services: Service[] }>('/api/services'),
  updateServiceLimits: (name: string, limits: ServiceLimits) =>
    post<{ ok: boolean; service: Service }>(`/api/services/${name}/limits`, limits),

  // Harness backlog (.harness/TASKS.json). Read-only EXCEPT the human-owned
  // `reviewed` flag, which lives in the owner-owned .harness/reviews.json (T136).
  // `markReviewed` writes it AND the daemon commits + pushes it to GitHub under the
  // loop lock; the response reports whether the push succeeded (`pushed`) and a
  // non-fatal `warning` if it didn't (e.g. offline) — the commit still persists.
  backlog: () => get<{ tasks: BacklogTask[]; defaults?: BacklogDefaults; error?: string }>('/api/backlog'),
  markReviewed: (id: string, reviewed: boolean) =>
    post<{ ok: boolean; id: string; reviewed: boolean; committed?: boolean; pushed?: boolean; warning?: string }>(
      `/api/backlog/${encodeURIComponent(id)}/reviewed`,
      { reviewed },
    ),

  // Read-only DB browser
  dbTables: () => get<{ tables: string[] }>('/api/db/tables'),
  dbTable: (name: string, limit = 50, offset = 0) =>
    get<TablePage>(`/api/db/tables/${name}?limit=${limit}&offset=${offset}`),
  // Named, read-only canned queries (no free-form SQL from the client)
  dbQueries: () => get<{ queries: CannedQueryMeta[] }>('/api/db/queries'),
  dbQuery: (id: string) => get<CannedQueryResult>(`/api/db/queries/${id}`),
};
