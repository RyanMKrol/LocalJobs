export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? 'http://127.0.0.1:4789';

export type RunStatus =
  | 'queued' | 'running' | 'success' | 'failed' | 'timeout' | 'cancelled';

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
}

export interface LogLine {
  id: number;
  ts: string;
  level: 'info' | 'warn' | 'error';
  message: string;
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
};
