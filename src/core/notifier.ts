import { config } from '../config.js';
import type { RunStatus } from './types.js';

/**
 * Send a failure alert via ntfy (if a topic is configured) and always fall
 * back to a macOS notification so something is visible locally. Never throws —
 * a broken notifier must not affect job execution.
 */
export async function notifyFailure(
  jobName: string,
  runId: string,
  status: RunStatus,
  error: string,
): Promise<void> {
  const title = `Job "${jobName}" ${status}`;
  const body = error.split('\n')[0].slice(0, 300);

  await Promise.allSettled([sendNtfy(title, body, jobName), sendMacNotification(title, body)]);
  // runId is included for traceability in logs.
  void runId;
}

async function sendNtfy(title: string, body: string, jobName: string): Promise<void> {
  if (!config.ntfyTopic) return;
  try {
    await fetch(`${config.ntfyServer}/${config.ntfyTopic}`, {
      method: 'POST',
      headers: {
        Title: title,
        Priority: 'high',
        Tags: 'warning',
        'X-Job': jobName,
      },
      body,
    });
  } catch {
    // swallow — dashboard still records the failure
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
