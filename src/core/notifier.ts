import { config } from '../config.js';
import { getRun, stuckCount } from '../db/store.js';
import type { RunStatus } from './types.js';

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

async function sendNtfy(
  title: string,
  body: string,
  jobName: string,
  priority: string,
  tags: string,
): Promise<void> {
  if (!config.ntfyTopic) return;
  try {
    await fetch(`${config.ntfyServer}/${config.ntfyTopic}`, {
      method: 'POST',
      headers: { Title: title, Priority: priority, Tags: tags, 'X-Job': jobName },
      body,
    });
  } catch {
    // swallow — the dashboard still records the run
  }
}

async function sendMacNotification(title: string, body: string): Promise<void> {
  try {
    const { spawn } = await import('node:child_process');
    const safe = (s: string) => s.replace(/["\\]/g, '');
    spawn('osascript', [
      '-e',
      `display notification "${safe(body)}" with title "${safe(title)}"`,
    ]).unref();
  } catch {
    // ignore
  }
}
