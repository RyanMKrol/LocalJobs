import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { config } from '../config.js';
import {
  activeRunOf,
  addLog,
  createRun,
  finishRun,
  getJob,
  recordNotStarted,
  recordSkippedRun,
  setProgress,
  type RunMeta,
} from '../db/store.js';
import { isPortsJob } from './ports.js';
import { ENGINE_PROTOCOL } from './protocol.js';
import { uncommittedOutputs } from './resolve-inputs.js';
import type { JobDefinition, JobEvent, RunStatus, RunTrigger } from './types.js';

/** Identity of the workflow run a member attempt belongs to, threaded to the child. */
export interface MemberRunContext extends RunMeta {
  workflowName?: string;
  /** What started the WORKFLOW run (the member's own trigger is always 'workflow'). */
  workflowTrigger?: RunTrigger;
}

/** Sleep that resolves early (returning true) if `signal` aborts, so a cancel
 *  never has to wait a pause out. Resolves false when the full time elapsed. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!!signal?.aborted);
  return new Promise((done) => {
    if (signal?.aborted) return done(true);
    const onAbort = () => { clearTimeout(t); done(true); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); done(false); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The wait before the Nth retry (1-based): the Nth configured value, last one repeating. */
export function retryDelayMs(retryNumber: number, schedule: number[] = config.retryBackoffMs): number {
  if (schedule.length === 0) return 0;
  return schedule[Math.min(retryNumber, schedule.length) - 1];
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
  ctx: MemberRunContext = {},
): Promise<{ runId: string | null; status: RunStatus }> {
  const jobRow = getJob(def.name);
  const timeoutMs = jobRow?.timeout_ms ?? def.timeoutMs ?? 0;
  const maxRetries = jobRow?.max_retries ?? def.maxRetries ?? 0;

  let lastRunId: string | null = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    // Already cancelled (before the first attempt, or between retries) — don't
    // spawn. If NO attempt ever ran, still leave a row saying so: a stage that
    // silently has no record is the hardest thing to debug afterwards.
    if (signal?.aborted) {
      if (!lastRunId && workflowRunId) {
        lastRunId = recordNotStarted(def.name, workflowRunId, 'not started: the workflow run was cancelled first', 'not-started-cancelled', ctx);
      }
      return { runId: lastRunId, status: 'cancelled' };
    }

    // Only the FIRST attempt carries the gate time; queue time is the same for all.
    const runId = createRun(def.name, trigger, attempt, workflowRunId, {
      cycle: ctx.cycle,
      queuedAtMs: ctx.queuedAtMs,
      gateMs: attempt === 1 ? ctx.gateMs : null,
    });
    lastRunId = runId;
    let outcome = await executeAttempt(def.name, runId, timeoutMs, signal, workflowRunId, { ...ctx, attempt });

    // A ports stage commits every declared output before it exits, and its own
    // process fails it if it did not. Checked again here, by the daemon, because
    // this is the promise the next stage relies on: "succeeded" must mean "its
    // outputs are recorded for this attempt".
    if (outcome.status === 'success' && isPortsJob(def)) {
      const missing = uncommittedOutputs(runId, def);
      if (missing.length > 0) {
        outcome = {
          status: 'failed',
          exitCode: outcome.exitCode,
          error:
            `stage reported success but recorded no committed artifact for its declared output(s): ${missing.join(', ')}. ` +
            `If the stage's code changed since the daemon started, restart the daemon (scripts/safe-restart.sh).`,
        };
        addLog(runId, outcome.error!, 'error');
      }
    }

    if (outcome.status === 'success') {
      finishRun(runId, 'success', { exitCode: 0 });
      return { runId, status: 'success' };
    }

    finishRun(runId, outcome.status, { exitCode: outcome.exitCode, error: outcome.error });
    // Cancellation is terminal — never retried (the whole workflow is stopping).
    if (outcome.status === 'cancelled') return { runId, status: 'cancelled' };
    if (attempt <= maxRetries) {
      const waitMs = retryDelayMs(attempt);
      addLog(
        runId,
        `Attempt ${attempt}/${maxRetries + 1} ${outcome.status}; retrying${waitMs > 0 ? ` in ${Math.round(waitMs / 1000)}s` : ''}...`,
        'warn',
      );
      // Abortable: a cancel during the wait stops the retry instead of waiting it out.
      if (await abortableSleep(waitMs, signal)) return { runId, status: 'cancelled' };
      continue;
    }
    return { runId, status: outcome.status };
  }
  return { runId: lastRunId, status: 'failed' };
}

/**
 * Run a job as a member of a workflow: its run row links to the workflow run and
 * the per-job notification is SUPPRESSED (the workflow sends stage notifications
 * instead). Returns the final status. If a run of this job from ANOTHER workflow
 * run is already active (`hasActiveRun` checks by job name only, not workflow run
 * id), it is recorded as 'skipped' (idempotency means that other run will cover
 * the work, and the next workflow run resumes anything outstanding).
 */
export async function runJobForWorkflow(
  def: JobDefinition,
  workflowRunId: string,
  signal?: AbortSignal,
  ctx: MemberRunContext = {},
): Promise<{ runId: string | null; status: RunStatus }> {
  const holder = activeRunOf(def.name);
  if (holder) {
    // Say WHO holds the job, so "why was this skipped" does not need guessing.
    const where = holder.workflow_run_id ? ` of workflow run ${holder.workflow_run_id}` : '';
    const runId = recordSkippedRun(
      def.name,
      workflowRunId,
      `skipped: another active run of this job is already in progress (run ${holder.id}${where})`,
      'overlap',
      ctx,
    );
    return { runId, status: 'skipped' };
  }
  return runAttempts(def, 'workflow', workflowRunId, signal, ctx);
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
  ctx: MemberRunContext & { attempt?: number } = {},
): Promise<AttemptOutcome> {
  return new Promise((resolveOutcome) => {
    // Cancelled before we even spawn — don't start a child at all.
    if (signal?.aborted) {
      resolveOutcome({ status: 'cancelled', exitCode: null, error: 'Cancelled before start' });
      return;
    }

    // Run identity for the child. The workflow run id lets a LIMITED run's frozen
    // originating-input allowlist (T094) reach the job via ctx.rootAllowed() and
    // attributes ledger writes to this run; the rest (this attempt's own run id,
    // attempt number, cycle, workflow name, trigger) lets the child record what
    // THIS attempt read and wrote. A standalone run (null) sets only the run id →
    // the child sees an unlimited, workflow-less run.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LOCALJOBS_ENGINE: String(ENGINE_PROTOCOL),
      LOCALJOBS_RUN_ID: runId,
      LOCALJOBS_RUN_ATTEMPT: String(ctx.attempt ?? 1),
      LOCALJOBS_RUN_CYCLE: String(ctx.cycle ?? 1),
      // When the stage became ready this cycle: "written this run" for an output
      // means written since then (so a retry attempt still counts the first
      // attempt's writes).
      LOCALJOBS_RUN_QUEUED_MS: String(ctx.queuedAtMs ?? Date.now()),
    };
    if (workflowRunId) env.LOCALJOBS_WORKFLOW_RUN_ID = workflowRunId;
    if (ctx.workflowName) env.LOCALJOBS_WORKFLOW_NAME = ctx.workflowName;
    if (ctx.workflowTrigger) env.LOCALJOBS_RUN_TRIGGER = ctx.workflowTrigger;
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
      try {
        // A line that parses as JSON but is not one of our events (a job that
        // `console.log`s a number or an object, a future event type an older
        // daemon does not know) is still OUTPUT: log it rather than drop it.
        const type = event !== null && typeof event === 'object' ? (event as { type?: unknown }).type : undefined;
        switch (type) {
          case 'log':
            addLog(runId, (event as Extract<JobEvent, { type: 'log' }>).message, (event as Extract<JobEvent, { type: 'log' }>).level);
            break;
          case 'progress':
            setProgress(runId, (event as Extract<JobEvent, { type: 'progress' }>).pct, (event as Extract<JobEvent, { type: 'progress' }>).message);
            break;
          case 'result': {
            const r = event as Extract<JobEvent, { type: 'result' }>;
            resultStatus = r.status;
            resultError = r.status === 'failed' ? r.error : null;
            break;
          }
          default:
            addLog(runId, trimmed);
        }
      } catch (err) {
        // A synchronous store throw (e.g. SQLITE_BUSY) must drop at most this
        // one line, not crash the daemon (T525).
        try {
          console.error(`[executor] run ${runId}: failed to record line event:`, err);
        } catch {
          // even the fallback log must never throw out of this handler
        }
      }
    });

    // Anything on stderr is captured as an error log line.
    const errRl = createInterface({ input: child.stderr });
    errRl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        addLog(runId, line, 'error');
      } catch (err) {
        try {
          console.error(`[executor] run ${runId}: failed to record stderr line:`, err);
        } catch {
          // even the fallback log must never throw out of this handler
        }
      }
    });

    child.on('error', (err) => {
      addLog(runId, `Failed to spawn job process: ${err.message}`, 'error');
      resultStatus = 'failed';
      resultError = err.message;
    });

    child.on('close', (code, killSignal) => {
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
      // Killed by a signal we did not send (the OS out-of-memory killer, a manual
      // `kill`): `code` is null there, so name the signal instead of "code null".
      const died = killSignal
        ? `Process was killed by ${killSignal} without reporting a result`
        : `Process exited with code ${code} without reporting a result`;
      resolveOutcome({
        status: 'failed',
        exitCode: code,
        error: resultError ?? died,
      });
    });
  });
}
