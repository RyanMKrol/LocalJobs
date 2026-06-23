import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { callService } from '../../core/services.js';
import { perfumesConfig } from './config.js';

export interface ClaudeResult {
  ok: boolean;
  text: string;        // the model's `.result` (its answer)
  rateLimited: boolean; // hit a usage/rate limit — back off, don't burn the item's retries
  error?: string;
}

// Best-effort detection of a usage/rate limit from the CLI's error text (there's no
// structured signal). `claude -p`'s known exact phrase is "Claude Usage Limit Reached"
// — matched explicitly here (and already covered by `usage limit`/`limit reached`), kept
// alongside a wide net so a reworded limit message still trips it.
const RATE_LIMIT_RE = /claude usage limit reached|rate.?limit|usage limit|429|too many requests|quota|exceeded your|reached your|limit reached|overloaded/i;

/**
 * Run a one-shot Claude Code CLI query. The prompt is piped via stdin (so large
 * page text isn't constrained by ARG_MAX), output parsed from the `--output-format
 * json` envelope's `.result`. Runs in a neutral cwd so it doesn't inherit this
 * repo's CLAUDE.md. Never throws — returns a result object.
 */
export function runClaude(prompt: string, model: string): Promise<ClaudeResult> {
  // Gate every Claude call through the shared 'claude-cli' service (metered, $0).
  return callService('claude-cli', () => spawnClaude(prompt, model));
}

function spawnClaude(prompt: string, model: string): Promise<ClaudeResult> {
  return new Promise((resolvePromise) => {
    const args = ['-p', '--output-format', 'json', '--model', model, '--dangerously-skip-permissions'];
    let child;
    try {
      child = spawn(perfumesConfig.claudeBin, args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolvePromise({ ok: false, text: '', rateLimited: false, error: String(e) });
    }
    let out = '';
    let err = '';
    let killedForTimeout = false;
    const timer = setTimeout(() => { killedForTimeout = true; child.kill('SIGKILL'); }, perfumesConfig.claudeTimeoutMs);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolvePromise({ ok: false, text: '', rateLimited: false, error: String(e) }); });
    child.on('close', () => {
      clearTimeout(timer);
      if (killedForTimeout) {
        return resolvePromise({ ok: false, text: '', rateLimited: false, error: `claude timed out after ${perfumesConfig.claudeTimeoutMs}ms` });
      }
      const blob = out.trim();
      try {
        const env = JSON.parse(blob) as { is_error?: boolean; subtype?: string; result?: unknown; error?: unknown };
        const isErr = env.is_error === true || (typeof env.subtype === 'string' && env.subtype.startsWith('error'));
        if (isErr) {
          const msg = String(env.result ?? env.error ?? env.subtype ?? 'claude error');
          return resolvePromise({ ok: false, text: '', rateLimited: RATE_LIMIT_RE.test(msg + ' ' + err), error: msg.slice(0, 300) });
        }
        return resolvePromise({ ok: true, text: String(env.result ?? ''), rateLimited: false });
      } catch {
        const msg = (err || blob || 'claude produced no parseable output').slice(0, 400);
        return resolvePromise({ ok: false, text: '', rateLimited: RATE_LIMIT_RE.test(msg), error: msg });
      }
    });

    child.stdin.on('error', () => { /* ignore EPIPE if the child died early */ });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Pull a JSON object out of the model's text (tolerating ```fences``` / prose). */
export function extractJson(text: string): unknown {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error(`no JSON object in result: ${text.slice(0, 120)}`);
  return JSON.parse(s.slice(a, b + 1));
}

/** Strip ```markdown fences``` if the model wrapped the file in them. */
export function unfenceMarkdown(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t).trim() + '\n';
}
