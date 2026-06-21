// Same-origin by default: the browser fetches `/api/*` from the dashboard's own
// origin, which Next.js rewrites (server-side, in next.config.js) to the loopback
// daemon API. This is what makes the dashboard reachable over a Tailscale tailnet
// without ever exposing the API — a remote browser talks ONLY to the dashboard.
// Override with an absolute base only if you intentionally point the browser at a
// directly-exposed API (then you also need LOCALJOBS_TOKEN + a CORS origin).
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

export type RunStatus =
  | 'queued' | 'running' | 'success' | 'failed' | 'timeout' | 'cancelled' | 'skipped';

export type PipelineRunStatus = 'running' | 'success' | 'partial' | 'failed' | 'cancelled';

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
  pipeline_run_id?: string | null;
}

export interface Job {
  name: string;
  description: string;
  schedule: string | null;
  timeout_ms: number;
  max_retries: number;
  enabled: number;
  created_at: string;
  last_run: Run | null;
  next_run: string | null;
  instructions: string | null;
  stuck: number;
  pipeline?: string | null; // set if this job is a pipeline member
}

export interface PipelineMember {
  job_name: string;
  depends_on: string[];
}

export interface PipelineRun {
  id: string;
  pipeline_name: string;
  status: PipelineRunStatus;
  trigger: string;
  progress: number;
  progress_msg: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface Pipeline {
  name: string;
  description: string;
  schedule: string | null;
  enabled: number;
  created_at: string;
  last_run: PipelineRun | null;
  next_run: string | null;
  jobs: PipelineMember[];
  stuck: number;
  runs?: PipelineRun[];
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
  runNow: (name: string) => post<{ ok: boolean }>(`/api/jobs/${name}/run`),
  toggle: (name: string, enabled: boolean) => post<{ ok: boolean }>(`/api/jobs/${name}/toggle`, { enabled }),
  stuck: (job?: string) => get<{ stuck: StuckItem[] }>(`/api/stuck${job ? `?job=${job}` : ''}`),
  unstick: (job: string, key: string) => post<{ ok: boolean; unstuck: number }>(`/api/stuck/unstick`, { job, key }),
  dismiss: (job: string, key: string) => post<{ ok: boolean; dismissed: number }>(`/api/stuck/dismiss`, { job, key }),

  recentPipelineRuns: (limit = 50) => get<{ runs: PipelineRun[] }>(`/api/pipeline-runs?limit=${limit}`),
  pipelines: () => get<{ pipelines: Pipeline[] }>('/api/pipelines'),
  pipeline: (name: string) => get<{ pipeline: Pipeline }>(`/api/pipelines/${name}`),
  pipelineRun: (id: string, after = 0) =>
    get<{ run: PipelineRun; jobs: Run[]; logs: LogLine[] }>(`/api/pipeline-runs/${id}?after=${after}`),
  runPipeline: (name: string) => post<{ ok: boolean }>(`/api/pipelines/${name}/run`),
  togglePipeline: (name: string, enabled: boolean) => post<{ ok: boolean }>(`/api/pipelines/${name}/toggle`, { enabled }),
  services: () => get<{ services: Service[] }>('/api/services'),
  updateServiceLimits: (name: string, limits: ServiceLimits) =>
    post<{ ok: boolean; service: Service }>(`/api/services/${name}/limits`, limits),

  // Read-only DB browser
  dbTables: () => get<{ tables: string[] }>('/api/db/tables'),
  dbTable: (name: string, limit = 50, offset = 0) =>
    get<TablePage>(`/api/db/tables/${name}?limit=${limit}&offset=${offset}`),
};
