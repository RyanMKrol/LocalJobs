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

/** One side (output/input) of a gate: the declared shape + a live check result. */
export interface GateSide {
  shape: ArtifactShape | null;
  result: GateResult | null;
}

/** Full inspection of a single gate: classified state + expected-vs-actual sides. */
export interface GateInspection {
  gate: GateStatus;
  output: GateSide | null;
  input: GateSide | null;
}

/** One row in the first-cut input→output mapping for a workflow run (T095). */
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
  note: string;
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
  do: string;
  doneWhen: string;
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
  ignored: (job?: string) => get<{ ignored: StuckItem[] }>(`/api/ignored${job ? `?job=${job}` : ''}`),
  unstick: (job: string, key: string) => post<{ ok: boolean; unstuck: number }>(`/api/stuck/unstick`, { job, key }),
  ignore: (job: string, key: string) => post<{ ok: boolean; ignored: number }>(`/api/stuck/ignore`, { job, key }),

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
  workflowRunIo: (id: string) => get<WorkflowIo>(`/api/workflow-runs/${id}/io`),
  runWorkflow: (name: string, limit?: number) =>
    post<{ ok: boolean; limit: number | null }>(`/api/workflows/${name}/run`, limit !== undefined ? { limit } : undefined),
  toggleWorkflow: (name: string, enabled: boolean) => post<{ ok: boolean }>(`/api/workflows/${name}/toggle`, { enabled }),
  cancelWorkflowRun: (id: string) => post<{ ok: boolean }>(`/api/workflow-runs/${id}/cancel`),
  services: () => get<{ services: Service[] }>('/api/services'),
  updateServiceLimits: (name: string, limits: ServiceLimits) =>
    post<{ ok: boolean; service: Service }>(`/api/services/${name}/limits`, limits),

  // Read-only harness backlog (.harness/TASKS.json)
  backlog: () => get<{ tasks: BacklogTask[]; defaults?: BacklogDefaults; error?: string }>('/api/backlog'),

  // Read-only DB browser
  dbTables: () => get<{ tables: string[] }>('/api/db/tables'),
  dbTable: (name: string, limit = 50, offset = 0) =>
    get<TablePage>(`/api/db/tables/${name}?limit=${limit}&offset=${offset}`),
  // Named, read-only canned queries (no free-form SQL from the client)
  dbQueries: () => get<{ queries: CannedQueryMeta[] }>('/api/db/queries'),
  dbQuery: (id: string) => get<CannedQueryResult>(`/api/db/queries/${id}`),
};
