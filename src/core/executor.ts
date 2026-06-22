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
 */
async function runAttempts(
  def: JobDefinition,
  trigger: RunTrigger,
  workflowRunId: string | null,
): Promise<{ runId: string | null; status: RunStatus }> {
  const jobRow = getJob(def.name);
  const timeoutMs = jobRow?.timeout_ms ?? def.timeoutMs ?? 0;
  const maxRetries = jobRow?.max_retries ?? def.maxRetries ?? 0;

  let lastRunId: string | null = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const runId = createRun(def.name, trigger, attempt, workflowRunId);
    lastRunId = runId;
    const outcome = await executeAttempt(def.name, runId, timeoutMs);

    if (outcome.status === 'success') {
      finishRun(runId, 'success', { exitCode: 0 });
      return { runId, status: 'success' };
    }

    finishRun(runId, outcome.status, { exitCode: outcome.exitCode, error: outcome.error });
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
): Promise<{ runId: string | null; status: RunStatus }> {
  if (hasActiveRun(def.name)) {
    const runId = recordSkippedRun(def.name, workflowRunId, 'skipped: a standalone run of this job is already active');
    return { runId, status: 'skipped' };
  }
  return runAttempts(def, 'workflow', workflowRunId);
}

interface AttemptOutcome {
  status: 'success' | 'failed' | 'timeout';
  exitCode: number | null;
  error: string | null;
}

function executeAttempt(jobName: string, runId: string, timeoutMs: number): Promise<AttemptOutcome> {
  return new Promise((resolveOutcome) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', config.runJobScript, jobName],
      { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
    );

    let resultStatus: 'success' | 'failed' | null = null;
    let resultError: string | null = null;
    let timedOut = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            addLog(runId, `Timeout after ${timeoutMs}ms — killing process`, 'error');
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 3000).unref();
          }, timeoutMs)
        : null;

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
