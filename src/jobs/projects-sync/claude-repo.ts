import { spawn } from 'node:child_process';
import { callService } from '../../core/services.js';
import type { ClaudeResult } from '../../services/claude.js';

/**
 * A SEPARATE, self-contained Claude CLI invocation for the `project-summarize`
 * stage ONLY. Unlike the shared `runClaude` helper in `src/services/claude.ts`
 * (which spawns in a neutral tmpdir with NO filesystem tool access, and is used
 * by other workflows — perfumes build, movies recommender branches — that must
 * NOT gain broad tool access as a side effect of this module existing), this
 * helper grants Claude scoped, READ-ONLY filesystem access to one cloned repo
 * directory so it can explore the real project (package.json, source layout,
 * other docs) instead of relying only on catalog metadata embedded in the
 * prompt. Still routed through the shared `claude-cli` service so the same
 * rate-limit/quota meter governs both invocation shapes.
 */

const claudeBin = process.env.LOCALJOBS_CLAUDE_BIN ?? 'claude';
const claudeTimeoutMs = Number(process.env.LOCALJOBS_CLAUDE_TIMEOUT_MS ?? 300_000);

const RATE_LIMIT_RE = /claude usage limit reached|rate.?limit|usage limit|429|too many requests|quota|exceeded your|reached your|limit reached|overloaded/i;

/** READ-ONLY exploration tools only — deliberately excludes Bash/Write/Edit or
 *  any other mutating tool, since this call is scoped to a live cloned repo dir. */
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

function spawnClaudeWithRepoAccess(prompt: string, model: string, repoDir: string, effort?: string): Promise<ClaudeResult> {
  return new Promise((resolvePromise) => {
    const args = buildRepoAccessArgs(model, repoDir, effort);
    let child;
    try {
      child = spawn(claudeBin, args, { cwd: repoDir, stdio: ['pipe', 'pipe', 'pipe'] });
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
 * Run a Claude CLI query with scoped, read-only filesystem tool access to
 * `repoDir` (cwd = repoDir, `--add-dir repoDir --allowedTools Read Glob Grep`).
 * Gated through the `claude-cli` service like `runClaude`. Never throws.
 */
export function runClaudeWithRepoAccess(prompt: string, model: string, repoDir: string, effort?: string): Promise<ClaudeResult> {
  return callService('claude-cli', () => spawnClaudeWithRepoAccess(prompt, model, repoDir, effort));
}
