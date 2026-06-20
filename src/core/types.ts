export type RunStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'timeout'
  | 'cancelled';

export type RunTrigger = 'schedule' | 'manual';

export type LogLevel = 'info' | 'warn' | 'error';

/** The context handed to every job's run() function. */
export interface JobContext {
  /** Append a log line (also surfaced live in the dashboard). */
  log(message: string, level?: LogLevel): void;
  /** Report progress 0..100 with an optional status message. */
  progress(pct: number, message?: string): void;
}

/** A job is a unit of work the orchestrator can schedule and run. */
export interface JobDefinition {
  /** Unique, stable identifier (also the primary key in the DB). */
  name: string;
  description?: string;
  /** Cron expression (croner syntax). Omit/null for manual-only jobs. */
  schedule?: string | null;
  /** Hard timeout in ms; the child process is killed if exceeded. 0 = none. */
  timeoutMs?: number;
  /** How many times to retry on failure before marking the run failed. */
  maxRetries?: number;
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
}
