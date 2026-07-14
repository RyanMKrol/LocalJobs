import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { callService, effectiveServiceTimeoutMs } from '../core/services.js';

/**
 * Shared, self-contained Claude Code CLI helper (the `claude -p --output-format
 * json` worker — $0 under the user's plan). It lives in the top-level services
 * layer (sibling of `claude-cli.service.ts`) precisely because more than one
 * workflow drives Claude: the perfumes build stage and the movies recommendation
 * branches (T146). Like every service helper it is self-contained — it reads its
 * binary from env and its timeout from `claudeTimeoutMs()` (an env-seeded default,
 * dashboard-overridable via the `claude-cli` service's limits, T465), and imports
 * nothing from any workflow's config. Every call is gated through the shared
 * `claude-cli` service (metered, sequential, no rate cap).
 *
 * (Perfumes keeps its own `perfumes/claude.ts` for now — migrating it onto this
 * shared helper is a follow-up; it was out of scope for T146. See
 * `.harness/docs/LIMITATIONS.md`.)
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
const claudeTimeoutMsDefault = Number(process.env.LOCALJOBS_CLAUDE_TIMEOUT_MS ?? 300_000); // 5 min/call
/**
 * The EFFECTIVE claude-cli timeout (ms) — a dashboard override (T465, via the
 * `claude-cli` service's `limits_overridden`/`timeout_ms`) wins over the env-var
 * default above. Read PER CALL (not cached at module load) so an edit takes effect
 * on the very next call without a daemon restart.
 */
export function claudeTimeoutMs(): number {
  return effectiveServiceTimeoutMs('claude-cli', claudeTimeoutMsDefault);
}

/**
 * Run a one-shot Claude Code CLI query. The prompt is piped via stdin (so a large
 * prompt isn't constrained by ARG_MAX), output parsed from the `--output-format
 * json` envelope's `.result`. Runs in a neutral cwd so it doesn't inherit this
 * repo's CLAUDE.md. Never throws — returns a result object.
 */
export function runClaude(prompt: string, model: string, effort?: string): Promise<ClaudeResult> {
  return callService('claude-cli', () => spawnClaudeCli(prompt, buildClaudeArgs(model, effort), {
    bin: claudeBin,
    timeoutMs: claudeTimeoutMs(),
    cwd: tmpdir(),
  }));
}

/**
 * Build the CLI argv for a `claude -p` call. `effort` maps to the CLI's separate
 * `--effort <low|medium|high|xhigh|max>` reasoning-effort flag; omitted when not
 * provided so existing callers keep the CLI's default behavior unchanged.
 */
export function buildClaudeArgs(model: string, effort?: string): string[] {
  return ['-p', '--output-format', 'json', '--model', model, ...(effort ? ['--effort', effort] : []), '--dangerously-skip-permissions'];
}

/** READ-ONLY exploration tools only — deliberately excludes Bash/Write/Edit or
 *  any other mutating tool, since a repo-access call is scoped to a live cloned
 *  repo dir (T566, moved from projects-sync/claude-repo.ts). */
export const REPO_ACCESS_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep'];

export function buildRepoAccessArgs(model: string, repoDir: string, effort?: string): string[] {
  return [
    '-p',
    '--output-format', 'json',
    '--model', model,
    ...(effort ? ['--effort', effort] : []),
    '--add-dir', repoDir,
    '--allowedTools', ...REPO_ACCESS_ALLOWED_TOOLS,
    '--dangerously-skip-permissions',
  ];
}

/**
 * Run a Claude CLI query with scoped, read-only filesystem tool access to
 * `repoDir` (cwd = repoDir, `--add-dir repoDir --allowedTools Read Glob Grep`).
 * Gated through the `claude-cli` service like `runClaude`, and reads the SAME
 * effective (dashboard-overridable) `claudeTimeoutMs()` per call — moved here from
 * projects-sync's own `claude-repo.ts`, which used to read `LOCALJOBS_CLAUDE_TIMEOUT_MS`
 * once at module load and so ignored a dashboard timeout override (T566). Never throws.
 */
export function runClaudeWithRepoAccess(prompt: string, model: string, repoDir: string, effort?: string): Promise<ClaudeResult> {
  return callService('claude-cli', () => spawnClaudeCli(prompt, buildRepoAccessArgs(model, repoDir, effort), {
    bin: claudeBin,
    timeoutMs: claudeTimeoutMs(),
    cwd: repoDir,
  }));
}

/**
 * The single spawn/timeout/parse primitive shared by every Claude CLI invocation
 * shape (`runClaude`'s neutral-cwd call, `runClaudeWithRepoAccess`'s scoped
 * repo-access call). Pipes `prompt` via stdin, parses the `--output-format json`
 * envelope, detects a rate/usage limit from the error text, and SIGKILLs the
 * child on timeout. Never throws — returns a result object.
 */
function spawnClaudeCli(prompt: string, args: string[], opts: { bin: string; timeoutMs: number; cwd: string }): Promise<ClaudeResult> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(opts.bin, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolvePromise({ ok: false, text: '', rateLimited: false, error: String(e) });
    }
    let out = '';
    let err = '';
    let killedForTimeout = false;
    const timer = setTimeout(() => { killedForTimeout = true; child.kill('SIGKILL'); }, opts.timeoutMs);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolvePromise({ ok: false, text: '', rateLimited: false, error: String(e) }); });
    child.on('close', () => {
      clearTimeout(timer);
      if (killedForTimeout) {
        return resolvePromise({ ok: false, text: '', rateLimited: false, error: `claude timed out after ${opts.timeoutMs}ms` });
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

/**
 * Strip a wrapping ```markdown/``` fence from a model's raw text, if present
 * (Claude occasionally fences a requested-plain markdown reply despite being
 * told not to). Moved here from `perfumes/claude.ts` (T566) so `projects-sync`
 * — and the eventual perfumes migration onto this shared helper (R02b) — can
 * both consume the same implementation.
 */
export function unfenceMarkdown(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t).trim() + '\n';
}
