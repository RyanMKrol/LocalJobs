import { config } from '../config.js';
import { getPipelineRun, getRun, stuckCount, workItemCounts } from '../db/store.js';
import type { LogLevel, PipelineRunStatus, RunStatus } from './types.js';

type LogFn = (message: string, level?: LogLevel) => void;

/**
 * Make a string safe to use as an HTTP header value. ntfy header fields (Title,
 * X-Job) must be Latin-1, so strip any non-printable-ASCII (emoji/Unicode) and
 * trim. The body keeps full Unicode, and emoji are conveyed via the Tags header.
 * Exported so the sanitiser can be unit-tested directly.
 */
export function sanitizeHeader(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, '').trim();
}

function fmtDur(ms: number | null | undefined): string {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
}

/**
 * Notify on a finished run — success, failure, or timeout. Sends a push via ntfy
 * (if a topic is configured) and always a local macOS notification. Includes a
 * short summary and a heads-up if the job has stuck items. Never throws — a
 * broken notifier must not affect job execution.
 */
export async function notifyRun(jobName: string, runId: string, status: RunStatus): Promise<void> {
  const run = getRun(runId);
  const stuck = stuckCount(jobName);
  const dur = fmtDur(run?.duration_ms);
  const ok = status === 'success';

  const emoji = ok ? '✅' : status === 'timeout' ? '⏱️' : '❌';
  const title = `${emoji} ${jobName} — ${status}`;

  const progress = run?.progress_msg?.trim();
  let body = ok
    ? (progress || 'Completed') + (dur ? ` · ${dur}` : '')
    : (run?.error ?? 'failed').split('\n')[0].slice(0, 180)
      + (progress ? `\n(reached: ${progress})` : '')
      + (dur ? ` · ${dur}` : '');
  if (stuck > 0) body += `\n⚠ ${stuck} item${stuck > 1 ? 's' : ''} stuck (won't retry — see dashboard)`;

  // Successes notify quietly; failures/timeouts are high priority.
  const priority = ok ? 'default' : 'high';
  const tags = ok ? 'white_check_mark' : status === 'timeout' ? 'hourglass' : 'rotating_light';

  await Promise.allSettled([
    sendNtfy(title, body, jobName, priority, tags),
    sendMacNotification(title, body),
  ]);
}

/** Generic push a long-running job can call to send milestone updates to the phone.
 *  Returns whether the ntfy push went out (so callers can log send failures). */
export async function push(
  title: string,
  body: string,
  opts: { priority?: string; tags?: string; job?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  const [ntfy] = await Promise.all([
    sendNtfy(title, body, opts.job ?? 'localjobs', opts.priority ?? 'default', opts.tags ?? 'bell'),
    sendMacNotification(title, body),
  ]);
  return ntfy;
}

/** Notify on a single pipeline STAGE (member job) completing — status + the job's
 *  work-item tally — and log the send outcome to the pipeline's framework log. */
export async function notifyStage(
  pipelineName: string,
  _pipelineRunId: string,
  jobName: string,
  status: RunStatus,
  log: LogFn,
): Promise<void> {
  const counts = workItemCounts(jobName);
  const ok = counts.success ?? 0;
  const failed = counts.failed ?? 0;
  const stuck = stuckCount(jobName);
  const emoji = status === 'success' ? '✓' : status === 'skipped' ? '⊘' : '✗';
  const title = `${emoji} ${pipelineName}: ${jobName} ${status}`;
  let body = `stage ${status}`;
  if (ok || failed) body += ` · ${ok} ok, ${failed} failed`;
  if (stuck) body += ` · ⚠ ${stuck} stuck`;
  const res = await push(title, body, {
    job: pipelineName,
    priority: status === 'success' ? 'low' : 'default',
    tags: status === 'success' ? 'white_check_mark' : status === 'skipped' ? 'fast_forward' : 'warning',
  });
  log(res.ok ? `notification sent — ${title}` : `notification FAILED (${res.error}) — ${title}`, res.ok ? 'info' : 'error');
}

/** Notify on the whole pipeline run finishing (aggregate), and log the outcome. */
export async function notifyPipeline(
  pipelineName: string,
  pipelineRunId: string,
  status: PipelineRunStatus,
  log: LogFn,
): Promise<void> {
  const run = getPipelineRun(pipelineRunId);
  const emoji = status === 'success' ? '✅' : status === 'partial' ? '⚠️' : status === 'cancelled' ? '🛑' : '❌';
  const title = `${emoji} ${pipelineName} pipeline — ${status}`;
  const body = (run?.progress_msg?.trim() || `pipeline ${status}`) + (run?.duration_ms ? ` · ${fmtDur(run.duration_ms)}` : '');
  const res = await push(title, body, {
    job: pipelineName,
    priority: status === 'success' ? 'default' : 'high',
    tags: status === 'success' ? 'tada' : 'rotating_light',
  });
  log(res.ok ? `notification sent — ${title}` : `notification FAILED (${res.error}) — ${title}`, res.ok ? 'info' : 'error');
}

async function sendNtfy(
  title: string,
  body: string,
  jobName: string,
  priority: string,
  tags: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!config.ntfyTopic) return { ok: true }; // not configured — nothing to fail
  try {
    const res = await fetch(`${config.ntfyServer}/${config.ntfyTopic}`, {
      method: 'POST',
      headers: { Title: sanitizeHeader(title) || 'localjobs', Priority: priority, Tags: tags, 'X-Job': sanitizeHeader(jobName) },
      body,
    });
    return res.ok ? { ok: true } : { ok: false, error: `ntfy HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function sendMacNotification(title: string, body: string): Promise<void> {
  try {
    const { spawn } = await import('node:child_process');
    const safe = (s: string) => s.replace(/["\\]/g, '');
    const child = spawn('osascript', [
      '-e',
      `display notification "${safe(body)}" with title "${safe(title)}"`,
    ]);
    // osascript only exists on macOS; on any other host (incl. CI) the spawn
    // emits an async 'error' event — swallow it so a missing binary can never
    // crash a job run with an unhandled error.
    child.on('error', () => {});
    child.unref();
  } catch {
    // ignore
  }
}
