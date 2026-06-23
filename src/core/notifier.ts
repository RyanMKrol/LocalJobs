import { config } from '../config.js';
import { getWorkflowRun, getRun, stuckCount, workItemCounts } from '../db/store.js';
import type { LogLevel, WorkflowRunStatus, RunStatus } from './types.js';

type LogFn = (message: string, level?: LogLevel) => void;

// ---------------------------------------------------------------------------
// ntfy backoff state (module-level; resetting on daemon restart is fine)
// ---------------------------------------------------------------------------

/** Epoch ms before which ntfy sends are suppressed. 0 = not backing off. */
let ntfyBackoffUntil = 0;
/** Current cooldown duration ms (doubles on each consecutive 429, capped). */
let ntfyBackoffMs = 0;
/** Injectable fetch for unit tests; defaults to the global. */
let _fetch: typeof fetch = globalThis.fetch;

/** Reset the in-process ntfy backoff state (exported for tests only). */
export function _resetNtfyBackoff(): void {
  ntfyBackoffUntil = 0;
  ntfyBackoffMs = 0;
}

/** Inspect current backoff state (exported for tests only). */
export function _ntfyBackoffState(): { until: number; cooldownMs: number } {
  return { until: ntfyBackoffUntil, cooldownMs: ntfyBackoffMs };
}

/** Swap the fetch implementation (exported for tests only). */
export function _setFetchForTest(fn: typeof fetch): void {
  _fetch = fn;
}

/** Restore the real fetch after tests. */
export function _resetFetchForTest(): void {
  _fetch = globalThis.fetch;
}

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

/** Notify on a single workflow STAGE (member job) completing — status + the job's
 *  work-item tally — and log the send outcome to the workflow's framework log. */
export async function notifyStage(
  workflowName: string,
  _workflowRunId: string,
  jobName: string,
  status: RunStatus,
  log: LogFn,
): Promise<void> {
  const counts = workItemCounts(jobName);
  const ok = counts.success ?? 0;
  const failed = counts.failed ?? 0;
  const stuck = stuckCount(jobName);
  const emoji = status === 'success' ? '✓' : status === 'skipped' ? '⊘' : '✗';
  const title = `${emoji} ${workflowName}: ${jobName} ${status}`;
  let body = `stage ${status}`;
  if (ok || failed) body += ` · ${ok} ok, ${failed} failed`;
  if (stuck) body += ` · ⚠ ${stuck} stuck`;
  const res = await push(title, body, {
    job: workflowName,
    priority: status === 'success' ? 'low' : 'default',
    tags: status === 'success' ? 'white_check_mark' : status === 'skipped' ? 'fast_forward' : 'warning',
  });
  log(res.ok ? `notification sent — ${title}` : `notification FAILED (${res.error}) — ${title}`, res.ok ? 'info' : 'error');
}

/** Notify on the whole workflow run finishing (aggregate), and log the outcome. */
export async function notifyWorkflow(
  workflowName: string,
  workflowRunId: string,
  status: WorkflowRunStatus,
  log: LogFn,
): Promise<void> {
  const run = getWorkflowRun(workflowRunId);
  const emoji = status === 'success' ? '✅' : status === 'partial' ? '⚠️' : status === 'cancelled' ? '🛑' : '❌';
  const title = `${emoji} ${workflowName} workflow — ${status}`;
  const body = (run?.progress_msg?.trim() || `workflow ${status}`) + (run?.duration_ms ? ` · ${fmtDur(run.duration_ms)}` : '');
  const res = await push(title, body, {
    job: workflowName,
    priority: status === 'success' ? 'default' : 'high',
    tags: status === 'success' ? 'tada' : 'rotating_light',
  });
  log(res.ok ? `notification sent — ${title}` : `notification FAILED (${res.error}) — ${title}`, res.ok ? 'info' : 'error');
}

/**
 * Low-level ntfy POST with exponential backoff on 429. Exported for tests so
 * callers can pass an arbitrary URL (bypassing the config.ntfyTopic guard).
 * Never throws — a broken notifier must not affect job execution.
 */
export async function _sendNtfyToUrl(
  url: string,
  title: string,
  body: string,
  jobName: string,
  priority: string,
  tags: string,
): Promise<{ ok: boolean; error?: string }> {
  const now = Date.now();
  if (ntfyBackoffUntil > now) {
    const remaining = Math.ceil((ntfyBackoffUntil - now) / 1000);
    return { ok: false, error: `ntfy suppressed — rate-limit cooldown (${remaining}s remaining)` };
  }
  try {
    const res = await _fetch(url, {
      method: 'POST',
      headers: { Title: sanitizeHeader(title) || 'localjobs', Priority: priority, Tags: tags, 'X-Job': sanitizeHeader(jobName) },
      body,
    });

    if (res.status === 429) {
      const base = config.ntfyBackoffBaseMs;
      const cap = config.ntfyBackoffCapMs;
      const retryAfterRaw = res.headers.get('Retry-After');
      let cooldown: number;
      if (retryAfterRaw !== null) {
        const secs = parseInt(retryAfterRaw, 10);
        cooldown = Math.min(isNaN(secs) ? base : secs * 1000, cap);
      } else {
        cooldown = Math.min(ntfyBackoffMs === 0 ? base : ntfyBackoffMs * 2, cap);
      }
      ntfyBackoffMs = cooldown;
      ntfyBackoffUntil = Date.now() + cooldown;
      return { ok: false, error: `ntfy HTTP 429 — backing off ${Math.round(cooldown / 1000)}s` };
    }

    if (res.ok) {
      ntfyBackoffUntil = 0;
      ntfyBackoffMs = 0;
      return { ok: true };
    }

    return { ok: false, error: `ntfy HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function sendNtfy(
  title: string,
  body: string,
  jobName: string,
  priority: string,
  tags: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!config.ntfyTopic) return { ok: true }; // not configured — nothing to fail
  return _sendNtfyToUrl(`${config.ntfyServer}/${config.ntfyTopic}`, title, body, jobName, priority, tags);
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
