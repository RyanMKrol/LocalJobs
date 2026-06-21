import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { config } from '../config.js';
import {
  addLog,
  createRun,
  finishRun,
  getJob,
  hasActiveRun,
  setProgress,
} from '../db/store.js';
import { notifyRun } from './notifier.js';
import type { JobDefinition, JobEvent, RunTrigger } from './types.js';

export interface RunResult {
  runId: string | null;
  skipped?: boolean;
  reason?: string;
}

/**
 * Run a job once in an isolated child process. Captures NDJSON events,
 * enforces the job's timeout (hard-kills the child), and records the full
 * lifecycle to the DB. Handles retries up to the job's maxRetries.
 */
export async function runJob(def: JobDefinition, trigger: RunTrigger): Promise<RunResult> {
  // Overlap prevention: never run two instances of the same job at once.
  if (hasActiveRun(def.name)) {
    return { runId: null, skipped: true, reason: 'already running' };
  }

  const jobRow = getJob(def.name);
  const timeoutMs = jobRow?.timeout_ms ?? def.timeoutMs ?? 0;
  const maxRetries = jobRow?.max_retries ?? def.maxRetries ?? 0;

  let lastRunId: string | null = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const runId = createRun(def.name, trigger, attempt);
    lastRunId = runId;
    const outcome = await executeAttempt(def.name, runId, timeoutMs);

    if (outcome.status === 'success') {
      finishRun(runId, 'success', { exitCode: 0 });
      await notifyRun(def.name, runId, 'success');
      return { runId };
    }

    // failed | timeout
    finishRun(runId, outcome.status, { exitCode: outcome.exitCode, error: outcome.error });

    const willRetry = attempt <= maxRetries;
    if (willRetry) {
      addLog(runId, `Attempt ${attempt} ${outcome.status}; retrying...`, 'warn');
      continue;
    }
    await notifyRun(def.name, runId, outcome.status);
    return { runId };
  }

  return { runId: lastRunId };
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
