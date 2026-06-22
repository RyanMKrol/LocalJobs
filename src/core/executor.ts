import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { config } from '../config.js';
import {
  addLog,
  createRun,
  finishRun,
  getJob,
  hasActiveRun,
  recordSkippedRun,
  setProgress,
} from '../db/store.js';
import { notifyRun } from './notifier.js';
import type { JobDefinition, JobEvent, RunStatus, RunTrigger } from './types.js';

export interface RunResult {
  runId: string | null;
  skipped?: boolean;
  reason?: string;
}

/**
 * The attempt+retry loop, shared by the standalone and workflow paths. Creates a
 * run row per attempt (optionally linked to a workflow run), spawns the child,
 * retries up to the job's maxRetries, and returns the final run id + status.
 * Does NOT notify or check overlap — the callers own those policies.
 *
 * An optional `signal` makes the attempt cancellable: an abort hard-kills the
 * in-flight child (SIGTERM→SIGKILL, like the timeout path) and the run settles
 * `cancelled` — a TERMINAL status that is NOT retried, so a cancelled workflow
 * stops cleanly without orphaning a process or spawning further attempts.
 */
async function runAttempts(
  def: JobDefinition,
  trigger: RunTrigger,
  workflowRunId: string | null,
  signal?: AbortSignal,
): Promise<{ runId: string | null; status: RunStatus }> {
  const jobRow = getJob(def.name);
  const timeoutMs = jobRow?.timeout_ms ?? def.timeoutMs ?? 0;
  const maxRetries = jobRow?.max_retries ?? def.maxRetries ?? 0;

  let lastRunId: string | null = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    // Already cancelled (e.g. between retries) — don't spawn another attempt.
    if (signal?.aborted) return { runId: lastRunId, status: 'cancelled' };

    const runId = createRun(def.name, trigger, attempt, workflowRunId);
    lastRunId = runId;
    const outcome = await executeAttempt(def.name, runId, timeoutMs, signal, workflowRunId);

    if (outcome.status === 'success') {
      finishRun(runId, 'success', { exitCode: 0 });
      return { runId, status: 'success' };
    }

    finishRun(runId, outcome.status, { exitCode: outcome.exitCode, error: outcome.error });
    // Cancellation is terminal — never retried (the whole workflow is stopping).
    if (outcome.status === 'cancelled') return { runId, status: 'cancelled' };
    if (attempt <= maxRetries) {
      addLog(runId, `Attempt ${attempt} ${outcome.status}; retrying...`, 'warn');
      continue;
    }
    return { runId, status: outcome.status };
  }
  return { runId: lastRunId, status: 'failed' };
}

/**
 * Run a standalone job: overlap-guarded, retried, and notified on the final
 * outcome. Unchanged public behaviour.
 */
export async function runJob(def: JobDefinition, trigger: RunTrigger): Promise<RunResult> {
  if (hasActiveRun(def.name)) {
    return { runId: null, skipped: true, reason: 'already running' };
  }
  const { runId, status } = await runAttempts(def, trigger, null);
  if (runId) await notifyRun(def.name, runId, status);
  return { runId };
}

/**
 * Run a job as a member of a workflow: its run row links to the workflow run and
 * the per-job notification is SUPPRESSED (the workflow sends stage notifications
 * instead). Returns the final status. If a standalone run of this job is already
 * active, it is recorded as 'skipped' (idempotency means the standalone run will
 * cover the work, and the next workflow run resumes anything outstanding).
 */
export async function runJobForWorkflow(
  def: JobDefinition,
  workflowRunId: string,
  signal?: AbortSignal,
): Promise<{ runId: string | null; status: RunStatus }> {
  if (hasActiveRun(def.name)) {
    const runId = recordSkippedRun(def.name, workflowRunId, 'skipped: a standalone run of this job is already active');
    return { runId, status: 'skipped' };
  }
  return runAttempts(def, 'workflow', workflowRunId, signal);
}

interface AttemptOutcome {
  status: 'success' | 'failed' | 'timeout' | 'cancelled';
  exitCode: number | null;
  error: string | null;
}

function executeAttempt(
  jobName: string,
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal,
  workflowRunId?: string | null,
): Promise<AttemptOutcome> {
  return new Promise((resolveOutcome) => {
    // Cancelled before we even spawn — don't start a child at all.
    if (signal?.aborted) {
      resolveOutcome({ status: 'cancelled', exitCode: null, error: 'Cancelled before start' });
      return;
    }

    // Pass the workflow run id to the child so a LIMITED run's frozen
    // originating-input allowlist (T094) reaches the job via ctx.rootAllowed().
    // A standalone run (null) sets nothing → the child sees an unlimited run.
    const env = workflowRunId
      ? { ...process.env, LOCALJOBS_WORKFLOW_RUN_ID: workflowRunId }
      : process.env;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', config.runJobScript, jobName],
      { stdio: ['ignore', 'pipe', 'pipe'], env },
    );

    let resultStatus: 'success' | 'failed' | null = null;
    let resultError: string | null = null;
    let timedOut = false;
    let cancelled = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            addLog(runId, `Timeout after ${timeoutMs}ms — killing process`, 'error');
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 3000).unref();
          }, timeoutMs)
        : null;

    // Cancellation: hard-kill the in-flight child (same SIGTERM→SIGKILL path as
    // the timeout) so aborting actually reaps the process rather than orphaning
    // it. The 'close' handler then settles this attempt as 'cancelled'.
    const onAbort = () => {
      cancelled = true;
      addLog(runId, 'Workflow cancelled — killing process', 'warn');
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    // Parse structured NDJSON events from stdout.
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: JobEvent;
      try {
        event = JSON.parse(trimmed) as JobEvent;
      } catch {
        addLog(runId, trimmed); // non-JSON stdout still gets logged
        return;
      }
      switch (event.type) {
        case 'log':
          addLog(runId, event.message, event.level);
          break;
        case 'progress':
          setProgress(runId, event.pct, event.message);
          break;
        case 'result':
          resultStatus = event.status;
          resultError = event.status === 'failed' ? event.error : null;
          break;
      }
    });

    // Anything on stderr is captured as an error log line.
    const errRl = createInterface({ input: child.stderr });
    errRl.on('line', (line) => {
      if (line.trim()) addLog(runId, line, 'error');
    });

    child.on('error', (err) => {
      addLog(runId, `Failed to spawn job process: ${err.message}`, 'error');
      resultStatus = 'failed';
      resultError = err.message;
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (cancelled) {
        resolveOutcome({ status: 'cancelled', exitCode: code, error: 'Cancelled — process killed' });
        return;
      }
      if (timedOut) {
        resolveOutcome({ status: 'timeout', exitCode: code, error: `Killed after ${timeoutMs}ms timeout` });
        return;
      }
      if (resultStatus === 'success') {
        resolveOutcome({ status: 'success', exitCode: code, error: null });
        return;
      }
      resolveOutcome({
        status: 'failed',
        exitCode: code,
        error: resultError ?? `Process exited with code ${code} without reporting a result`,
      });
    });
  });
}
