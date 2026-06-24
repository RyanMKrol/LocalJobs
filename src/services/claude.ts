import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { callService } from '../core/services.js';

/**
 * Shared, self-contained Claude Code CLI helper (the `claude -p --output-format
 * json` worker — $0 under the user's plan). It lives in the top-level services
 * layer (sibling of `claude-cli.service.ts`) precisely because more than one
 * workflow drives Claude: the perfumes build stage and the movies recommendation
 * branches (T146). Like every service helper it is self-contained — it reads its
 * binary + timeout from env with sensible defaults and imports nothing from any
 * workflow's config. Every call is gated through the shared `claude-cli` service
 * (metered, sequential, no rate cap).
 *
 * (Perfumes keeps its own `perfumes/claude.ts` for now — migrating it onto this
 * shared helper is a follow-up; it was out of scope for T146. See
 * `.harness/LIMITATIONS.md`.)
 */
export interface ClaudeResult {
  ok: boolean;
  text: string;        // the model's `.result` (its answer)
  rateLimited: boolean; // hit a usage/rate limit — back off, don't burn retries
  error?: string;
}

// Best-effort detection of a usage/rate limit from the CLI's error text (there's
// no structured signal). Mirrors the perfumes helper's wide net.
const RATE_LIMIT_RE = /claude usage limit reached|rate.?limit|usage limit|429|too many requests|quota|exceeded your|reached your|limit reached|overloaded/i;

const claudeBin = process.env.LOCALJOBS_CLAUDE_BIN ?? 'claude';
const claudeTimeoutMs = Number(process.env.LOCALJOBS_CLAUDE_TIMEOUT_MS ?? 300_000); // 5 min/call

/**
 * Run a one-shot Claude Code CLI query. The prompt is piped via stdin (so a large
 * prompt isn't constrained by ARG_MAX), output parsed from the `--output-format
 * json` envelope's `.result`. Runs in a neutral cwd so it doesn't inherit this
 * repo's CLAUDE.md. Never throws — returns a result object.
 */
export function runClaude(prompt: string, model: string): Promise<ClaudeResult> {
  return callService('claude-cli', () => spawnClaude(prompt, model));
}

function spawnClaude(prompt: string, model: string): Promise<ClaudeResult> {
  return new Promise((resolvePromise) => {
    const args = ['-p', '--output-format', 'json', '--model', model, '--dangerously-skip-permissions'];
    let child;
    try {
      child = spawn(claudeBin, args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolvePromise({ ok: false, text: '', rateLimited: false, error: String(e) });
    }
    let out = '';
    let err = '';
    let killedForTimeout = false;
    const timer = setTimeout(() => { killedForTimeout = true; child.kill('SIGKILL'); }, claudeTimeoutMs);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolvePromise({ ok: false, text: '', rateLimited: false, error: String(e) }); });
    child.on('close', () => {
      clearTimeout(timer);
      if (killedForTimeout) {
        return resolvePromise({ ok: false, text: '', rateLimited: false, error: `claude timed out after ${claudeTimeoutMs}ms` });
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

/**
 * Pull a JSON object out of the model's text (tolerating ```fences``` / prose).
 * Throws if no object is present (the caller treats that as "junk → skip branch").
 */
export function extractJsonObject(text: string): unknown {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error(`no JSON object in result: ${text.slice(0, 120)}`);
  return JSON.parse(s.slice(a, b + 1));
}
