import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join as joinPath, relative as relativePath, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { acquireRepoLock, resolveRepoPaths } from '../core/repo-lock.js';
import { type Gate, buildDag, classifyGates, deriveGates, shapesIdentical } from '../core/dag.js';
import type { GateResult } from '../core/types.js';
import { runWorkflow, cancelWorkflowRun, workflowRunInProgress, effectiveWorkflowConcurrency, DEFAULT_WORKFLOW_CONCURRENCY } from '../core/workflow-executor.js';
import { nextWorkflowRun, rescheduleWorkflow } from '../core/scheduler.js';
import { Cron } from 'croner';
import { getJobDefinition, getWorkflowDefinition } from '../jobs/registry.js';
import { moviesConfig } from '../jobs/movies/config.js';
import { NOTIFY_JOB as MOVIE_GAPS_JOB, gapKey } from '../jobs/movies/stages/notify.js';
import type { FranchiseGapsFile } from '../jobs/movies/types.js';
import { plexConfig } from '../jobs/plex/config.js';
import { NOTIFY_JOB as PLEX_SEASONS_JOB, pairKey } from '../jobs/plex/stages/notify.js';
import type { MissingSeasonsFile } from '../jobs/plex/types.js';
import {
  browseTable,
  getLogs,
  getWorkflow,
  getWorkflowJobs,
  getWorkflowLogs,
  getWorkflowRun,
  getRun,
  lastWorkflowRunForWorkflow,
  lastRunForJob,
  listJobs,
  listWorkflowRunsForWorkflow,
  listWorkflows,
  listRecentWorkflowRuns,
  listRecentRuns,
  listRunsForJob,
  listRunsForWorkflowRun,
  listCannedQueries,
  listDbTables,
  listServices,
  runCannedQuery,
  orphanedWorkItems,
  pruneOrphanedWorkItems,
  workItemIoRows,
  workflowHasRunLinkage,
  workItemMarkdownPath,
  serviceCallsInLastSeconds,
  serviceCallsThisMonth,
  serviceCallsToday,
  updateServiceLimits,
  listServiceConsumers,
  setWorkflowEnabled,
  updateWorkflowSchedule,
  updateWorkflowConcurrency,
  stuckCount,
  stuckItems,
  unstickWorkItem,
  ignoreWorkItem,
  ignoreSurfacedItem,
  ignoredItemKeys,
  isWorkItemDone,
  ignoredItems,
  bulkUnstickItems,
  bulkIgnoreItems,
  type BulkStuckScope,
} from '../db/store.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  // CORS headers are applied per-request by applyCors() via res.setHeader before
  // routing, so we only set the content type here (writeHead merges with those).
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

// The harness backlog (.harness/TASKS.json), resolved relative to this file so it
// works regardless of the daemon's cwd. This is a READ-ONLY pass-through for the
// dashboard — the loop owns `status`, and the human-owned `reviewed` flag now lives
// in its OWN owner-owned file (`.harness/reviews.json`, T136), NOT in TASKS.json.
const BACKLOG_PATH = fileURLToPath(new URL('../../.harness/TASKS.json', import.meta.url));

// The owner-owned reviews store (T136). `reviewed` is the ONE human/dashboard-owned
// piece of backlog state, and it is the SOLE source of truth here — it no longer
// lives in TASKS.json (which the loop owns). The file is a committed JSON map
// `id → { reviewed: bool, at: ISO-8601 }`. `POST /api/backlog/:id/reviewed`
// atomically writes it AND, under the SAME lock loop.sh uses, commits + pushes it
// (see `commitReviewsFile`). Because reviews.json is a DISJOINT git path from
// everything the loop commits (TASKS.json / worklog), the two writers never conflict.
const REVIEWS_PATH = fileURLToPath(new URL('../../.harness/reviews.json', import.meta.url));

/** Default the reviews-store path to sit beside a given backlog file. */
function reviewsPathFor(backlogPath: string): string {
  return joinPath(dirname(backlogPath), 'reviews.json');
}

/**
 * Read a task's Markdown spec (its `## Do` / `## Done when` sections — the SOLE
 * source of do/doneWhen since T131). `specRel` is the JSON `spec` path, relative
 * to the repo root; `baseDir` is the backlog file's directory so it resolves the
 * same regardless of cwd. Confined to a `.harness/tasks/*.md` file (no traversal,
 * markdown only) — a local file read, never a network/paid call. Returns the file
 * text, or null if the field is absent / unreadable / outside the allowed dir.
 */
export function readTaskSpec(specRel: unknown, baseDir: string): string | null {
  if (typeof specRel !== 'string' || !specRel) return null;
  // The repo root is the backlog file's parent's parent (.harness/TASKS.json).
  const repoRoot = dirname(baseDir);
  const abs = resolvePath(repoRoot, specRel);
  if (!abs.toLowerCase().endsWith('.md')) return null;
  const tasksDir = joinPath(baseDir, 'tasks');
  if (!isWithin(tasksDir, abs)) return null; // must live under .harness/tasks/
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** An entry in the owner-owned reviews store (`.harness/reviews.json`, T136). */
export interface ReviewEntry {
  reviewed: boolean;
  at?: string;
}

/**
 * Read the reviews store (`id → { reviewed, at }`). Returns `{}` when the file is
 * absent, empty, or unparseable — so a fresh repo (no reviews yet) reads cleanly.
 * Exported for unit testing.
 */
export function readReviews(path: string = REVIEWS_PATH): Record<string, ReviewEntry> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, ReviewEntry>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Read the backlog and OVERLAY the owner-owned reviews store: each task's
 * `reviewed` is `reviews[id]?.reviewed ?? false` (the task objects no longer carry
 * the field, T136). Also inlines each task's Markdown spec content (`spec` →
 * `specContent`, T131) so the dashboard renders Do / Done-when without a second
 * request. `reviewsPath` defaults to `reviews.json` beside the backlog file.
 */
function readBacklog(
  path: string = BACKLOG_PATH,
  reviewsPath: string = reviewsPathFor(path),
): { tasks: unknown[]; error?: string } {
  try {
    const baseDir = dirname(path);
    const reviews = readReviews(reviewsPath);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { tasks?: unknown[] };
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks.map((t) => {
          if (!(t && typeof t === 'object' && !Array.isArray(t))) return t;
          const task = t as { id?: unknown; spec?: unknown };
          const specContent = readTaskSpec(task.spec, baseDir);
          const reviewed = typeof task.id === 'string' ? reviews[task.id]?.reviewed === true : false;
          return { ...(t as object), reviewed, ...(specContent !== null ? { specContent } : {}) };
        })
      : [];
    return { tasks };
  } catch (e) {
    return { tasks: [], error: e instanceof Error ? e.message : 'cannot read backlog' };
  }
}

/**
 * Pure, field-scoped edit of the reviews-store TEXT: parse `raw` (may be empty →
 * treated as `{}`), set ONLY the entry for `id` to `{ reviewed, at }`, and return
 * the re-serialised JSON (2-space, trailing newline). Every other id is preserved
 * verbatim. Exported for unit testing.
 */
export function setReviewEntry(raw: string, id: string, reviewed: boolean, at: string): string {
  let map: Record<string, ReviewEntry> = {};
  if (raw.trim()) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed as Record<string, ReviewEntry>;
  }
  map[id] = { reviewed, at };
  return `${JSON.stringify(map, null, 2)}\n`;
}

/**
 * Pure, field-scoped edit of the reviews-store TEXT for MULTIPLE ids at once:
 * parse `raw` (may be empty → treated as `{}`), set ALL entries in `ids` to
 * `{ reviewed, at }`, and return the re-serialised JSON. Every other id is preserved.
 * Exported for unit testing — no git, no disk.
 */
export function setReviewEntries(raw: string, ids: string[], reviewed: boolean, at: string): string {
  let map: Record<string, ReviewEntry> = {};
  if (raw.trim()) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed as Record<string, ReviewEntry>;
  }
  for (const id of ids) map[id] = { reviewed, at };
  return `${JSON.stringify(map, null, 2)}\n`;
}

/**
 * Atomically persist a single id's review entry to the reviews store. Reads the
 * current file (absent → `{}`), applies the field-scoped edit ({@link setReviewEntry}),
 * validates the result parses, then writes via temp-file + rename so a concurrent
 * reader never observes a half-written file. This is the durability floor — the
 * caller commits + pushes the file separately.
 */
function writeReviewEntry(path: string, id: string, reviewed: boolean, at: string): void {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    raw = ''; // absent → start from {}
  }
  const updated = setReviewEntry(raw, id, reviewed, at);
  JSON.parse(updated); // validate before we touch disk
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, updated);
  renameSync(tmp, path); // atomic replace
}

/**
 * Atomically persist multiple ids' review entries to the reviews store in ONE write.
 * Same atomic temp-file + rename approach as writeReviewEntry; all ids land in a
 * single disk write so no partial state is ever observable.
 */
function writeReviewEntries(path: string, ids: string[], reviewed: boolean, at: string): void {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    raw = '';
  }
  const updated = setReviewEntries(raw, ids, reviewed, at);
  JSON.parse(updated); // validate before we touch disk
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, updated);
  renameSync(tmp, path); // atomic replace
}

/**
 * One-time migration (T136): move `reviewed` OUT of TASKS.json into the owner-owned
 * reviews store. Given the TASKS.json text, returns the rewritten TASKS.json (every
 * task's `reviewed` field stripped, all other fields/tasks preserved) and the seeded
 * reviews.json (every task that was `reviewed:true` becomes `{ reviewed:true, at }`).
 * Pure + generic so it round-trips regardless of how many tasks were reviewed.
 * Exported for unit testing.
 */
export function migrateReviewsOut(tasksRaw: string, at: string): { tasksJson: string; reviewsJson: string } {
  const parsed = JSON.parse(tasksRaw) as { tasks?: Array<Record<string, unknown>> };
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const reviews: Record<string, ReviewEntry> = {};
  for (const t of tasks) {
    if (!(t && typeof t === 'object')) continue;
    if (t.reviewed === true && typeof t.id === 'string') reviews[t.id] = { reviewed: true, at };
    delete t.reviewed;
  }
  return {
    tasksJson: `${JSON.stringify(parsed, null, 2)}\n`,
    reviewsJson: `${JSON.stringify(reviews, null, 2)}\n`,
  };
}

const pexecFile = promisify(execFile);

/** Run a git command (arg array, never a shell string) in `repoRoot`. Never throws —
 *  returns `{ ok, stdout, stderr }` so callers can branch on non-zero exits. */
async function git(
  repoRoot: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await pexecFile('git', args, {
      cwd: repoRoot,
      timeout: timeoutMs,
      encoding: 'utf8',
      // Never let a push block on an interactive credential/SSH prompt — that would
      // pin the loop lock until the timeout. Belt-and-braces with the timeout bound.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' },
    });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: (err.stderr || err.message || '').toString() };
  }
}

export interface CommitReviewsResult {
  committed: boolean;
  pushed: boolean;
  warning?: string;
}

/**
 * Commit + push the reviews file under the SAME mkdir lock loop.sh uses, so the
 * daemon's git ops are mutually exclusive with the autonomous loop (T136). The
 * reviews file has ALREADY been written to disk by the caller (durability floor);
 * this stages ONLY that file explicitly, commits it `[skip ci]`, then
 * fetch + rebase + push with a bounded retry on a non-fast-forward race (clean,
 * because reviews.json is disjoint from every path the loop commits). A failed push
 * is a NON-FATAL warning, not an error — the commit will go out on the next push.
 * The lock is always released in a `finally`. The whole git phase is bounded by a
 * timeout so a hung network can't pin the loop lock indefinitely.
 */
export async function commitReviewsFile(opts: {
  repoRoot: string;
  reviewsAbsPath: string;
  id: string;
  reviewed: boolean;
  mainBranch?: string;
  lockDir?: string;
  push?: boolean;
  timeoutMs?: number;
  commitMessage?: string;
}): Promise<CommitReviewsResult> {
  const { repoRoot, reviewsAbsPath, id, reviewed } = opts;
  const mainBranch = opts.mainBranch ?? process.env.MAIN_BRANCH ?? 'main';
  const push = opts.push ?? true;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const relPath = relativePath(repoRoot, reviewsAbsPath);
  const commitMsg = opts.commitMessage ?? `reviews: ${id} reviewed=${reviewed} [skip ci]`;

  const release = await acquireRepoLock({ lockDir: opts.lockDir, cwd: repoRoot, timeoutMs });
  try {
    await git(repoRoot, ['add', '--', relPath], timeoutMs); // stage ONLY reviews.json, explicitly
    const noChanges = await git(repoRoot, ['diff', '--cached', '--quiet', '--', relPath], timeoutMs);
    if (noChanges.ok) return { committed: false, pushed: false }; // nothing staged (idempotent re-write)

    const commit = await git(
      repoRoot,
      // `--no-gpg-sign`: the daemon commits headlessly under launchd (no TTY /
      // pinentry / reachable gpg-agent), so if the user's git config has
      // `commit.gpgsign=true` an ordinary commit would FAIL to sign and leave
      // reviews.json staged-but-uncommitted. These are automated housekeeping
      // commits — never sign them, regardless of the ambient config.
      ['commit', '--no-gpg-sign', '-m', commitMsg],
      timeoutMs,
    );
    if (!commit.ok) return { committed: false, pushed: false, warning: commit.stderr.trim().slice(0, 300) };
    if (!push) return { committed: true, pushed: false };

    let warning: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      await git(repoRoot, ['fetch', 'origin'], timeoutMs);
      const rebase = await git(repoRoot, ['rebase', `origin/${mainBranch}`], timeoutMs);
      if (!rebase.ok) await git(repoRoot, ['rebase', '--abort'], timeoutMs); // no upstream / conflict → push as-is
      const pushed = await git(repoRoot, ['push', 'origin', `HEAD:${mainBranch}`], timeoutMs);
      if (pushed.ok) return { committed: true, pushed: true };
      warning = pushed.stderr.trim().slice(0, 300) || 'push failed';
    }
    return { committed: true, pushed: false, warning: warning ?? 'push failed' };
  } finally {
    release();
  }
}

/**
 * Default reviews-commit wiring for the live daemon: write is done by the caller;
 * here we resolve the repo root from the reviews file's directory and commit+push.
 * If the path is not inside a git repo (e.g. unit-test temp dir), the git phase is
 * skipped with a non-fatal warning — the atomic file write is still the durability
 * guarantee.
 */
async function defaultCommitReviews(reviewsPath: string, id: string, reviewed: boolean): Promise<CommitReviewsResult> {
  let repoRoot: string;
  try {
    repoRoot = resolveRepoPaths(dirname(reviewsPath)).root;
  } catch {
    return { committed: false, pushed: false, warning: 'not a git repo — wrote locally only' };
  }
  try {
    return await commitReviewsFile({ repoRoot, reviewsAbsPath: reviewsPath, id, reviewed });
  } catch (e) {
    return { committed: false, pushed: false, warning: e instanceof Error ? e.message : 'commit failed' };
  }
}

async function defaultCommitReviewsBulk(reviewsPath: string, ids: string[]): Promise<CommitReviewsResult> {
  let repoRoot: string;
  try {
    repoRoot = resolveRepoPaths(dirname(reviewsPath)).root;
  } catch {
    return { committed: false, pushed: false, warning: 'not a git repo — wrote locally only' };
  }
  try {
    // Reuse commitReviewsFile with a custom message for the bulk case. The `id` /
    // `reviewed` fields are only used to build the default commit message, which we
    // override here, so we pass placeholder values.
    return await commitReviewsFile({
      repoRoot,
      reviewsAbsPath: reviewsPath,
      id: '',
      reviewed: true,
      commitMessage: `reviews: bulk ${ids.length} reviewed [skip ci]`,
    });
  } catch (e) {
    return { committed: false, pushed: false, warning: e instanceof Error ? e.message : 'commit failed' };
  }
}

// Serialize concurrent in-daemon `reviewed` POSTs so two requests can't interleave
// the write+commit (the mkdir lock guards cross-process; this guards in-process).
let reviewChain: Promise<unknown> = Promise.resolve();
function serializeReview<T>(fn: () => Promise<T>): Promise<T> {
  const next = reviewChain.then(fn, fn);
  reviewChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// The jobs tree (src/jobs), resolved relative to this file. Job output artifacts
// (e.g. the markdown profiles the places/perfumes final stages write) live in
// each job's own `data/out/` folder under here. The output endpoint confines its
// reads to this tree so a recorded path can never escape it. `realpathSync` so
// the prefix check survives platform symlinks (e.g. macOS /var → /private/var).
const JOBS_ROOT = realpathSync(fileURLToPath(new URL('../jobs', import.meta.url)));

/** Whether `child` is the same as, or nested under, `parent` (path-prefix safe). */
export function isWithin(parent: string, child: string): boolean {
  const rel = relativePath(parent, child);
  // Inside iff the relative path doesn't climb out (`..`) and isn't absolute.
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}

/**
 * Resolve a job-recorded output path to a safe, real, absolute path — or null if
 * it isn't a readable markdown artifact inside a job's `data/out/` tree. This is
 * the path-traversal guard for the read-only output endpoint:
 *  - resolved + symlink-followed (realpath) so `..`/symlink escapes are caught,
 *  - must stay under {@link JOBS_ROOT},
 *  - must live inside a job-local `data/out/` directory,
 *  - must be a regular `.md` file that exists.
 * No network/paid calls — a local file stat + realpath only.
 */
export function safeOutputMarkdown(candidate: string | null): string | null {
  if (!candidate) return null;
  const abs = resolvePath(candidate);
  if (!abs.toLowerCase().endsWith('.md')) return null;
  let real: string;
  try {
    real = realpathSync(abs); // follows symlinks; throws if the file is missing
  } catch {
    return null;
  }
  if (!isWithin(JOBS_ROOT, real)) return null; // escaped the jobs tree
  if (!real.includes(`${sep}data${sep}out${sep}`)) return null; // not a job output artifact
  try {
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

/**
 * Resolve a bulk-stuck-action request body to a `BulkStuckScope`, or null if
 * the body specifies an unknown workflow. Accepts:
 *   {} or { scope: 'all' }           → all stuck items
 *   { scope: 'job', job: 'name' }    → one job
 *   { scope: 'workflow', workflow }   → member jobs of the named workflow
 */
function resolveBulkScope(body: Record<string, unknown>): BulkStuckScope | null {
  const scope = body.scope as string | undefined;
  if (!scope || scope === 'all') return { type: 'all' };
  if (scope === 'job') {
    const jobName = body.job as string | undefined;
    return { type: 'job', jobName: jobName ?? '' };
  }
  if (scope === 'workflow') {
    const wfName = body.workflow as string | undefined;
    if (!wfName) return { type: 'all' }; // no name → all
    const members = getWorkflowJobs(wfName);
    if (members.length === 0) return null; // unknown workflow
    return { type: 'workflow', jobNames: members.map((m) => m.job_name) };
  }
  return { type: 'all' };
}

/** True if `origin` is one of the configured allowlist entries. */
export function originAllowed(origin: string | undefined, allowlist: readonly string[]): boolean {
  return !!origin && allowlist.includes(origin);
}

/**
 * Set CORS headers for this request. Reflects the request `Origin` ONLY when it's
 * in the allowlist (never `*`); a disallowed origin gets no
 * `Access-Control-Allow-Origin`, so a browser blocks the response. `Vary: Origin`
 * keeps caches from leaking one origin's decision to another.
 */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-LocalJobs-Token, Authorization');
  const origin = req.headers.origin;
  if (originAllowed(origin, config.allowedOrigins)) {
    res.setHeader('Access-Control-Allow-Origin', origin as string);
  }
}

/** True for the loopback addresses Node reports for local connections. */
export function isLoopbackAddress(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * Whether a mutating (POST) request may proceed. Loopback callers (the local
 * dashboard, curl on the box) are always allowed. A non-loopback caller — e.g.
 * over Tailscale — must present the shared token (via `X-LocalJobs-Token` or
 * `Authorization: Bearer`), and only when a token is configured at all.
 */
export function authoriseMutation(args: {
  remoteAddress: string | undefined;
  headers: IncomingMessage['headers'];
  token: string;
  isLoopback?: (addr: string | undefined) => boolean;
}): boolean {
  if ((args.isLoopback ?? isLoopbackAddress)(args.remoteAddress)) return true;
  if (!args.token) return false;
  const header = args.headers['x-localjobs-token'];
  const supplied = Array.isArray(header) ? header[0] : header;
  const auth = args.headers['authorization'];
  const bearer = (Array.isArray(auth) ? auth[0] : auth ?? '').replace(/^Bearer\s+/i, '');
  return supplied === args.token || bearer === args.token;
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * Decorate a job row with its last run. A job is only ever a workflow member
 * (T037/T070): scheduling, the enable toggle, the next-run and run-now all live
 * on the workflow, so the job view carries none of them — it is a read-only
 * member view (status, run history, logs).
 */
function jobView(name: string) {
  return {
    last_run: lastRunForJob(name) ?? null,
    has_def: !!getJobDefinition(name),
    stuck: stuckCount(name),
  };
}

/** Decorate a workflow with its last/next run, member jobs+edges, and total stuck.
 *  `limitable` (T094) is true when some member declares `inputKeys()` — only then
 *  can a manual run be limited to N originating inputs (the dashboard shows the
 *  limit input only for limitable workflows). */
function workflowView(name: string) {
  const members = getWorkflowJobs(name);
  return {
    last_run: lastWorkflowRunForWorkflow(name) ?? null,
    next_run: nextWorkflowRun(name),
    jobs: members,
    stuck: members.reduce((sum, m) => sum + stuckCount(m.job_name), 0),
    limitable: members.some((m) => !!getJobDefinition(m.job_name)?.inputKeys),
  };
}

/**
 * Derive the validation gates for a workflow from its members' declared
 * produces/consumes contracts (the same `deriveGates` the executor enforces).
 * Pure structure — gate STATE is layered on per-run by `classifyGates`. A
 * malformed DAG yields no gates (the run endpoint surfaces the DAG error itself).
 */
function gatesForWorkflow(name: string): Gate[] {
  const refs = getWorkflowJobs(name).map((m) => ({ job: m.job_name, dependsOn: m.depends_on }));
  let dag;
  try {
    dag = buildDag(refs);
  } catch {
    return [];
  }
  const produces = new Map<string, string[]>();
  const consumes = new Map<string, string[]>();
  for (const node of dag.nodes) {
    const jd = getJobDefinition(node);
    produces.set(node, (jd?.produces ?? []).map((c) => c.key));
    consumes.set(node, (jd?.consumes ?? []).map((c) => c.key));
  }
  // Enrich each derived gate with a human description of what its contracts
  // assert (producer's `produces[key]` + consumer's `consumes[key]` descriptions)
  // so the dashboard's per-gate detail can explain what the gate validates.
  return deriveGates(dag, produces, consumes).map((g) => {
    const pd = getJobDefinition(g.producer)?.produces?.find((c) => c.key === g.key)?.description;
    const cd = getJobDefinition(g.consumer)?.consumes?.find((c) => c.key === g.key)?.description;
    const parts = [pd && `produced: ${pd}`, cd && `consumed: ${cd}`].filter(Boolean) as string[];
    return parts.length ? { ...g, description: parts.join(' · ') } : g;
  });
}

/** Map each workflow member job → its workflow name (for grouping the jobs list). */
function memberWorkflowMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of listWorkflows()) for (const m of getWorkflowJobs(p.name)) map.set(m.job_name, p.name);
  return map;
}

/**
 * Build the API HTTP server (not yet listening). Split out from `startApi` so
 * tests can drive it on an ephemeral port. `opts.isLoopback` lets a test
 * simulate a non-loopback (remote) caller to exercise the mutation guard.
 */
export function createApiServer(
  opts: {
    isLoopback?: (addr: string | undefined) => boolean;
    backlogPath?: string;
    reviewsPath?: string;
    // Injectable for tests: commit+push the reviews file. Defaults to the real git
    // path (resolves the repo from the reviews dir; no-ops outside a git repo).
    commitReviews?: (reviewsPath: string, id: string, reviewed: boolean) => Promise<CommitReviewsResult>;
    commitReviewsBulk?: (reviewsPath: string, ids: string[]) => Promise<CommitReviewsResult>;
  } = {},
) {
  const isLoopback = opts.isLoopback ?? isLoopbackAddress;
  const backlogPath = opts.backlogPath ?? BACKLOG_PATH;
  const reviewsPath = opts.reviewsPath ?? reviewsPathFor(backlogPath);
  const commitReviews = opts.commitReviews ?? defaultCommitReviews;
  const commitReviewsBulk = opts.commitReviewsBulk ?? defaultCommitReviewsBulk;
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${config.apiPort}`);
    const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','jobs','demo','runs']
    const method = req.method ?? 'GET';

    applyCors(req, res);

    if (method === 'OPTIONS') return json(res, 204, {});

    // Guard every mutating (POST) endpoint: loopback is trusted; a remote caller
    // needs the shared token. Reads (GET) stay open so the dashboard works.
    if (method === 'POST' &&
        !authoriseMutation({ remoteAddress: req.socket.remoteAddress, headers: req.headers, token: config.authToken, isLoopback })) {
      return json(res, 401, { error: 'unauthorised' });
    }

    try {
      // GET /api/health
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'health') {
        return json(res, 200, { ok: true, time: new Date().toISOString() });
      }

      // GET /api/runs?limit=
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'runs' && parts.length === 2) {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        return json(res, 200, { runs: listRecentRuns(limit) });
      }

      // GET /api/runs/:id  (+ ?after= for incremental logs)
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'runs' && parts.length === 3) {
        const run = getRun(parts[2]);
        if (!run) return json(res, 404, { error: 'run not found' });
        const after = Number(url.searchParams.get('after') ?? 0);
        return json(res, 200, { run, logs: getLogs(parts[2], after) });
      }

      // GET /api/stuck  (optionally ?job=<name> or ?workflow=<name>) — items that gave up, won't retry
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'stuck' && parts.length === 2) {
        const jobFilter = url.searchParams.get('job');
        const wfFilter = url.searchParams.get('workflow');
        let items = stuckItems();
        if (jobFilter) {
          items = items.filter((i) => i.job_name === jobFilter);
        } else if (wfFilter) {
          if (!getWorkflow(wfFilter)) return json(res, 404, { error: 'workflow not found' });
          const memberJobs = new Set(getWorkflowJobs(wfFilter).map((m) => m.job_name));
          items = items.filter((i) => memberJobs.has(i.job_name));
        }
        return json(res, 200, { stuck: items });
      }

      // POST /api/stuck/unstick  { job, key } — reset a stuck item so it retries
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'stuck' && parts[2] === 'unstick') {
        const body = await readBody(req);
        if (!body.job || !body.key) return json(res, 400, { error: 'job and key are required' });
        const unstuck = unstickWorkItem(String(body.job), String(body.key));
        return json(res, 200, { ok: true, unstuck });
      }

      // POST /api/stuck/ignore  { job, key } — permanently park a stuck item
      // (manual only; never retries, drops off the stuck list, shows on the
      // overview's Ignored tile)
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'stuck' && parts[2] === 'ignore') {
        const body = await readBody(req);
        if (!body.job || !body.key) return json(res, 400, { error: 'job and key are required' });
        const ignored = ignoreWorkItem(String(body.job), String(body.key));
        return json(res, 200, { ok: true, ignored });
      }

      // POST /api/stuck/unstick-bulk  { scope?: 'all'|{job}|{workflow} }
      // Bulk-unstick: delete all currently-failed rows in scope so they retry fresh.
      // scope omitted / 'all' → every stuck item; { job } → one job; { workflow } → its members.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'stuck' && parts[2] === 'unstick-bulk') {
        const body = await readBody(req);
        const scope = resolveBulkScope(body);
        if (scope === null) return json(res, 400, { error: 'invalid scope: workflow must be a known workflow name' });
        const unstuck = bulkUnstickItems(scope);
        return json(res, 200, { ok: true, unstuck });
      }

      // POST /api/stuck/ignore-bulk  { scope?: 'all'|{job}|{workflow} }
      // Bulk-ignore: permanently mark all currently-failed rows in scope as 'ignored'.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'stuck' && parts[2] === 'ignore-bulk') {
        const body = await readBody(req);
        const scope = resolveBulkScope(body);
        if (scope === null) return json(res, 400, { error: 'invalid scope: workflow must be a known workflow name' });
        const ignored = bulkIgnoreItems(scope);
        return json(res, 200, { ok: true, ignored });
      }

      // GET /api/ignored  (optionally ?job=<name>) — manually-parked items
      // (overview-only; never counted as stuck)
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'ignored' && parts.length === 2) {
        const jobFilter = url.searchParams.get('job');
        const items = ignoredItems().filter((i) => !jobFilter || i.job_name === jobFilter);
        return json(res, 200, { ignored: items });
      }

      // GET /api/movie-gaps — the current franchise gaps (read from the movies
      // workflow's franchise-gaps.json), each overlaid with its ledger status:
      // `notified` (already digested) and `ignored` (owner-suppressed). Read-only,
      // file + DB only — never a paid/remote call. Returns an empty list (not an
      // error) when the audit hasn't run yet.
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'movie-gaps' && parts.length === 2) {
        let file: FranchiseGapsFile = { generatedAt: '', collectionsChecked: 0, gaps: [] };
        try {
          file = JSON.parse(readFileSync(moviesConfig.gapsOut, 'utf8')) as FranchiseGapsFile;
        } catch {
          // No franchise-gaps.json yet (audit hasn't run) — return an empty backlog.
        }
        const ignoredKeys = ignoredItemKeys(MOVIE_GAPS_JOB);
        const gaps = (file.gaps ?? []).map((g) => {
          const key = gapKey(g.tmdbId);
          return {
            ...g,
            ignored: ignoredKeys.has(key),
            notified: isWorkItemDone(MOVIE_GAPS_JOB, key, 1) && !ignoredKeys.has(key),
          };
        });
        return json(res, 200, {
          generatedAt: file.generatedAt || null,
          collectionsChecked: file.collectionsChecked ?? 0,
          gaps,
          collectionExamples: file.collectionExamples ?? {},
        });
      }

      // POST /api/movie-gaps/:tmdbId/ignore — owner manually IGNORES a surfaced
      // franchise gap so it leaves BOTH future reports AND notifications and never
      // resurfaces (even though the film is still un-owned). Manual only; guarded by
      // the global loopback/token mutation check above. Idempotent (re-ignoring is a
      // no-op upsert).
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'movie-gaps' && parts[3] === 'ignore') {
        const tmdbId = Number(parts[2]);
        if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
          return json(res, 400, { error: 'tmdbId must be a positive integer' });
        }
        const ignored = ignoreSurfacedItem(MOVIE_GAPS_JOB, gapKey(tmdbId));
        return json(res, 200, { ok: true, ignored });
      }

      // GET /api/missing-seasons — the currently-detected complete-missing TV seasons
      // (read from missing-seasons.json), each overlaid with its notified/ignored state
      // from the plex-seasons-notify ledger. Read-only, file + DB only.
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'missing-seasons' && parts.length === 2) {
        let file: MissingSeasonsFile = { generatedAt: '', shows: [], unverifiable: [] };
        try {
          file = JSON.parse(readFileSync(plexConfig.missingOut, 'utf8')) as MissingSeasonsFile;
        } catch {
          // missing-seasons.json not yet written (workflow hasn't run) — return empty.
        }
        const ignoredKeys = ignoredItemKeys(PLEX_SEASONS_JOB);
        const shows = (file.shows ?? []).flatMap((s) =>
          s.completeMissingSeasons.map((season) => {
            const key = pairKey(s.tmdbId, season);
            return {
              tmdbId: s.tmdbId,
              title: s.title,
              year: s.year,
              season,
              tmdbStatus: s.tmdbStatus,
              ignored: ignoredKeys.has(key),
              notified: isWorkItemDone(PLEX_SEASONS_JOB, key, 1) && !ignoredKeys.has(key),
            };
          }),
        );
        return json(res, 200, { generatedAt: file.generatedAt || null, shows });
      }

      // POST /api/missing-seasons/:tmdbId/:season/ignore — suppress a season gap from
      // future reports + notifications. Guarded by the global loopback/token mutation check.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'missing-seasons' && parts[4] === 'ignore') {
        const tmdbId = Number(parts[2]);
        const season = Number(parts[3]);
        if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !Number.isInteger(season) || season <= 0) {
          return json(res, 400, { error: 'tmdbId and season must be positive integers' });
        }
        const ignored = ignoreSurfacedItem(PLEX_SEASONS_JOB, pairKey(tmdbId, season));
        return json(res, 200, { ok: true, ignored });
      }

      // GET /api/jobs  (each flagged with its workflow, if it's a member)
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'jobs' && parts.length === 2) {
        const memberOf = memberWorkflowMap();
        const rows = listJobs().map((j) => ({ ...j, ...jobView(j.name), workflow: memberOf.get(j.name) ?? null }));
        return json(res, 200, { jobs: rows });
      }

      // GET /api/jobs/:name/runs
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'jobs' && parts[3] === 'runs') {
        return json(res, 200, { runs: listRunsForJob(parts[2]) });
      }

      // GET /api/jobs/:name
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'jobs' && parts.length === 3) {
        const job = listJobs().find((j) => j.name === parts[2]);
        if (!job) return json(res, 404, { error: 'job not found' });
        return json(res, 200, { job: { ...job, ...jobView(job.name) } });
      }

      // NOTE: there is intentionally NO POST /api/jobs/:name/run (T070). A job is
      // only ever a workflow member — you run a WORKFLOW (POST /api/workflows/:name/run),
      // never a job; a job runs when its prerequisites are met inside its workflow.

      // POST /api/jobs/:name/prune  { keys?: string[], dryRun?: boolean, force?: boolean }
      // MANUAL-ONLY: remove work_items whose item_key is no longer in the job's
      // current input set (orphans from a corrected id). The current set comes
      // from the request `keys`, else the job's inputKeys(). `dryRun` previews
      // what WOULD be removed. An empty current set (which would orphan EVERY
      // ledger row) is refused unless `force` is set, to defend against a
      // misbehaving inputKeys(). Never triggered automatically.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'jobs' && parts[3] === 'prune') {
        const jobName = parts[2];
        const def = getJobDefinition(jobName);
        const body = await readBody(req);
        let keys: string[] | undefined;
        if (Array.isArray(body.keys)) keys = body.keys.map(String);
        else if (def?.inputKeys) keys = await def.inputKeys();
        if (!keys) {
          return json(res, 400, {
            error: 'no current input key-set: provide { keys: [...] } or define inputKeys() on the job',
          });
        }
        if (keys.length === 0 && !body.force) {
          return json(res, 400, {
            error: 'current input set is empty — this would prune ALL work_items for the job; pass { force: true } if intended',
          });
        }
        if (body.dryRun) {
          return json(res, 200, { ok: true, dryRun: true, job: jobName, orphaned: orphanedWorkItems(jobName, keys) });
        }
        const removed = pruneOrphanedWorkItems(jobName, keys);
        console.log(`[api] prune ${jobName}: removed ${removed.length} orphaned work_item(s)`);
        return json(res, 200, { ok: true, job: jobName, removed });
      }

      // NOTE: there is intentionally NO POST /api/jobs/:name/toggle (T070). The
      // enable toggle lives on the workflow (POST /api/workflows/:name/toggle) —
      // a job has no enabled flag of its own.

      // GET /api/workflows
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workflows' && parts.length === 2) {
        const rows = listWorkflows().map((p) => ({ ...p, ...workflowView(p.name) }));
        return json(res, 200, { workflows: rows });
      }

      // GET /api/workflows/:name/runs
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workflows' && parts[3] === 'runs') {
        return json(res, 200, { runs: listWorkflowRunsForWorkflow(parts[2]) });
      }

      // GET /api/workflows/:name
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workflows' && parts.length === 3) {
        const p = getWorkflow(parts[2]);
        if (!p) return json(res, 404, { error: 'workflow not found' });
        // Effective bounded parallelism (T169): the user override / synced manifest
        // value / default — the same number runWorkflow will use — so the detail page
        // can show the current cap even when `max_concurrency` is NULL (not overridden).
        const wfDef = getWorkflowDefinition(p.name);
        // For the API response, return the raw effective value (0 = unlimited sentinel, T201).
        // `effectiveWorkflowConcurrency` maps 0→Infinity for the executor; we keep 0 here so
        // the dashboard can detect and display "Unlimited" without serialising Infinity (NaN in JSON).
        const rawEff = wfDef
          ? (getWorkflow(p.name)?.max_concurrency ?? wfDef.maxConcurrency ?? DEFAULT_WORKFLOW_CONCURRENCY)
          : (p.max_concurrency ?? DEFAULT_WORKFLOW_CONCURRENCY);
        const effective_max_concurrency = rawEff;
        return json(res, 200, { workflow: { ...p, effective_max_concurrency, ...workflowView(p.name), gates: gatesForWorkflow(p.name), runs: listWorkflowRunsForWorkflow(p.name, 20) } });
      }

      // GET /api/workflows/:name/gates/:producer/:key
      // Run-AGNOSTIC, definition-level inspection of ONE validation gate for the
      // definition view's gate detail page: the structural gate (key, enriched
      // description, producer→consumer) plus each side's declared `shape` — the
      // EXPECTED side only. It does NOT run the contracts' `check()`, so there are
      // NO per-run actuals and NO file/paid/remote reads at all (purely the
      // statically-declared contract metadata) — safe to load freely. The
      // run-scoped GET /api/workflow-runs/:id/gates/... endpoint is the one that
      // layers a specific run's actual-vs-expected on top.
      if (
        method === 'GET' && parts[0] === 'api' && parts[1] === 'workflows' &&
        parts[3] === 'gates' && parts.length === 6
      ) {
        const name = parts[2];
        if (!getWorkflow(name)) return json(res, 404, { error: 'workflow not found' });
        const producer = decodeURIComponent(parts[4]);
        const key = decodeURIComponent(parts[5]);
        const gate = gatesForWorkflow(name).find((g) => g.producer === producer && g.key === key);
        if (!gate) return json(res, 404, { error: 'gate not found' });
        const sideShape = (jobName: string, field: 'produces' | 'consumes') =>
          getJobDefinition(jobName)?.[field]?.find((c) => c.key === key)?.shape ?? null;
        const producedShape = sideShape(gate.producer, 'produces');
        const consumedShape = sideShape(gate.consumer, 'consumes');
        return json(res, 200, {
          gate,
          produced: { shape: producedShape },
          consumed: { shape: consumedShape },
          // When both sides declare the SAME contract shape (the normal case —
          // one factory wired as both produces[key] and consumes[key]), the detail
          // page collapses to a single panel; an asymmetric gate keeps both sides.
          identical: shapesIdentical(producedShape, consumedShape),
        });
      }

      // POST /api/workflows/:name/run   (optional body { limit })
      // A positive-integer `limit` caps the manual run to N originating inputs and
      // runs all their fan-out (T094); omit it for an unlimited run. A limit is
      // rejected for a workflow with no stage that declares input keys.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workflows' && parts[3] === 'run') {
        const def = getWorkflowDefinition(parts[2]);
        if (!def) return json(res, 404, { error: 'workflow not found' });
        const body = await readBody(req);
        let limit: number | undefined;
        if (body.limit !== undefined && body.limit !== null && body.limit !== '') {
          limit = Number(body.limit);
          if (!Number.isInteger(limit) || limit < 1) {
            return json(res, 400, { error: 'limit must be a positive integer' });
          }
          if (!def.jobs.some((j) => getJobDefinition(j.job)?.inputKeys)) {
            return json(res, 400, { error: `workflow "${def.name}" cannot be limited (no stage declares input keys)` });
          }
        }
        // One active run per workflow (T105): reject a duplicate start with 409
        // rather than appearing to start a second run. This check + the fire below
        // run with no await between them, and `runWorkflow` claims the name
        // synchronously, so the executor remains the authoritative atomic guard.
        if (workflowRunInProgress(def.name)) {
          return json(res, 409, { error: `workflow "${def.name}" already has an active run`, running: true });
        }
        runWorkflow(def, 'manual', { limit }).catch((e) => console.error('[api] workflow run error', e));
        return json(res, 202, { ok: true, message: 'workflow run started', limit: limit ?? null });
      }

      // POST /api/workflows/:name/toggle  { enabled }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workflows' && parts[3] === 'toggle') {
        const body = await readBody(req);
        setWorkflowEnabled(parts[2], !!body.enabled);
        return json(res, 200, { ok: true, enabled: !!body.enabled });
      }

      // POST /api/workflows/:name/schedule  { schedule }
      // Persist a USER override of the workflow's cron schedule (T135) and apply it
      // to the live scheduler WITHOUT a daemon restart — the user-owned schedule is
      // preserved across code-syncs (via `schedule_overridden`, like `enabled`). An
      // empty/blank value clears it to manual-only (null). A non-empty value MUST be
      // a valid croner pattern — validated by attempting `new Cron(expr, {paused})`
      // — else 400 (never crashing the daemon). Unknown workflow → 404. Mutating, so
      // it goes through the same loopback/token guard as /toggle, /run, /limits above.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workflows' && parts[3] === 'schedule') {
        const name = parts[2];
        if (!getWorkflow(name)) return json(res, 404, { error: 'workflow not found' });
        const body = await readBody(req);
        const raw = typeof body.schedule === 'string' ? body.schedule.trim() : '';
        const schedule = raw === '' ? null : raw;
        if (schedule !== null) {
          try {
            new Cron(schedule, { paused: true }).stop();
          } catch (e) {
            return json(res, 400, { error: `invalid cron expression: ${e instanceof Error ? e.message : String(e)}` });
          }
        }
        updateWorkflowSchedule(name, schedule);
        rescheduleWorkflow(name, schedule);
        return json(res, 200, { ok: true, schedule, next_run: nextWorkflowRun(name) });
      }

      // POST /api/workflows/:name/concurrency  { maxConcurrency }
      // Persist a USER override of the workflow's bounded-parallelism cap (T169).
      // Mirrors the schedule override: user-owned + code-reconciled (via
      // `max_concurrency_overridden`, like `enabled`/`schedule`). `runWorkflow` reads
      // the effective value FRESH each run, so an edit takes effect on the NEXT run
      // with no daemon restart. The value MUST be a positive integer ≥ 1 — else 400,
      // before it reaches the store. Unknown workflow → 404. Mutating, so it goes
      // through the same loopback/token guard as /toggle, /run, /schedule, /limits.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workflows' && parts[3] === 'concurrency') {
        const name = parts[2];
        if (!getWorkflow(name)) return json(res, 404, { error: 'workflow not found' });
        const body = await readBody(req);
        const n = Number(body.maxConcurrency);
        if (!Number.isInteger(n) || (n !== 0 && n < 1)) {
          return json(res, 400, { error: 'maxConcurrency must be a positive integer ≥ 1, or 0 for unlimited' });
        }
        updateWorkflowConcurrency(name, n);
        return json(res, 200, { ok: true, max_concurrency: n });
      }

      // GET /api/workflow-runs?limit=
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workflow-runs' && parts.length === 2) {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        return json(res, 200, { runs: listRecentWorkflowRuns(limit) });
      }

      // GET /api/workflow-runs/:id  (+ ?after= for incremental framework logs)
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workflow-runs' && parts.length === 3) {
        const run = getWorkflowRun(parts[2]);
        if (!run) return json(res, 404, { error: 'workflow run not found' });
        const after = Number(url.searchParams.get('after') ?? 0);
        const memberRuns = listRunsForWorkflowRun(parts[2]);
        // Gates are run-scoped: derive the workflow's gate structure, then classify
        // each against THIS run's member runs (passed / failed / pending). The
        // structure-only /workflows/:name view gets structural gates (no run state).
        const gates = classifyGates(gatesForWorkflow(run.workflow_name), memberRuns);
        return json(res, 200, { run, jobs: memberRuns, logs: getWorkflowLogs(parts[2], after), gates });
      }

      // POST /api/workflow-runs/:id/cancel — abort a RUNNING workflow run.
      // Mutating (guarded by authoriseMutation above): hard-kills in-flight member
      // children and stops launching further stages. The run must exist and be
      // 'running' AND be active in this daemon process (present in the executor's
      // registry); the executor records the 'cancelled' transition once it observes
      // the abort. A terminal/unknown run returns a clear error.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workflow-runs' && parts[3] === 'cancel' && parts.length === 4) {
        const run = getWorkflowRun(parts[2]);
        if (!run) return json(res, 404, { error: 'workflow run not found' });
        if (run.status !== 'running') return json(res, 409, { error: `workflow run is ${run.status}, not running` });
        if (!cancelWorkflowRun(parts[2])) {
          return json(res, 409, { error: 'workflow run is not active in this process (cannot cancel)' });
        }
        console.log(`[api] cancel requested for workflow run ${parts[2]}`);
        return json(res, 200, { ok: true });
      }

      // GET /api/workflow-runs/:id/gates/:producer/:key
      // Inspect ONE validation gate for the dashboard's expected-vs-actual view:
      // the classified gate state plus, for each side (produced = producer's
      // `produces[key]`, consumed = consumer's `consumes[key]`), the contract's
      // declared `shape` and a LIVE `check()` of the artifact on disk (per-
      // expectation pass/fail + a small sample of what flowed). Reads files only —
      // never a paid/remote call — so it's safe to poll.
      if (
        method === 'GET' && parts[0] === 'api' && parts[1] === 'workflow-runs' &&
        parts[3] === 'gates' && parts.length === 6
      ) {
        const run = getWorkflowRun(parts[2]);
        if (!run) return json(res, 404, { error: 'workflow run not found' });
        const producer = decodeURIComponent(parts[4]);
        const key = decodeURIComponent(parts[5]);
        const memberRuns = listRunsForWorkflowRun(parts[2]);
        const gates = classifyGates(gatesForWorkflow(run.workflow_name), memberRuns);
        const gate = gates.find((g) => g.producer === producer && g.key === key);
        if (!gate) return json(res, 404, { error: 'gate not found' });
        const inspectSide = async (jobName: string, field: 'produces' | 'consumes') => {
          const contract = getJobDefinition(jobName)?.[field]?.find((c) => c.key === key);
          if (!contract) return null;
          let result: GateResult;
          try {
            result = await contract.check();
          } catch (e) {
            result = { ok: false, violations: [`check threw — ${e instanceof Error ? e.message : e}`] };
          }
          return { shape: contract.shape ?? null, result };
        };
        const produced = await inspectSide(gate.producer, 'produces');
        const consumed = await inspectSide(gate.consumer, 'consumes');
        // `identical` is a deep compare of the DECLARED shapes only (not the live
        // actuals), so the page can collapse the duplicated producer/consumer
        // panels when both sides assert the same contract (the normal case).
        const identical = shapesIdentical(produced?.shape ?? null, consumed?.shape ?? null);
        return json(res, 200, { gate, produced, consumed, identical });
      }

      // GET /api/workflow-runs/:id/io
      // Run-scoped input→output mapping for a workflow run (T095, T139). Lists the
      // originating inputs THIS run advanced (from the work_item_runs linkage) and
      // resolves each one's output from the first/last-wave work_items. DB reads
      // only — safe to poll. A run with no linkage (pre-feature or a re-run that
      // advanced nothing new) returns an empty, honestly-explained result rather
      // than dumping the global ledger.
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workflow-runs' && parts[3] === 'io' && parts.length === 4) {
        const run = getWorkflowRun(parts[2]);
        if (!run) return json(res, 404, { error: 'workflow run not found' });
        const refs = getWorkflowJobs(run.workflow_name).map((m) => ({ job: m.job_name, dependsOn: m.depends_on }));
        let firstWave: string[] = [];
        let lastWave: string[] = [];
        try {
          const dag = buildDag(refs);
          firstWave = dag.waves[0] ?? [];
          lastWave = dag.waves[dag.waves.length - 1] ?? [];
          // If the workflow is a single stage, first == last — show it as both input and output.
        } catch {
          return json(res, 200, { io: [], firstWave: [], lastWave: [], scoped: false, emptyReason: null, note: 'workflow DAG could not be parsed' });
        }
        const { rows, scoped } = workItemIoRows(firstWave, lastWave, run.id);
        // Distinguish an old pre-feature run (workflow has NO linkage at all) from a
        // re-run that simply advanced nothing new (the workflow HAS linkage elsewhere).
        const emptyReason = scoped || rows.length > 0
          ? null
          : workflowHasRunLinkage(run.workflow_name) ? 'no-new' : 'pre-feature';
        return json(res, 200, {
          io: rows,
          firstWave,
          lastWave,
          scoped,
          emptyReason,
          // Honest caveat shown as a footnote when there ARE rows.
          note: 'One output is shown per input (fan-out is collapsed to its first output).',
        });
      }

      // GET /api/workflow-runs/:id/output?job=<job>&key=<key>  (T110)
      // Read-only: return the markdown artifact a job produced for one work item,
      // for the workflow-run IO panel's output preview + full popover. The path
      // comes from the work item's recorded detail.markdown and is confined by
      // safeOutputMarkdown() to a `.md` file inside a job's own data/out/ tree —
      // no path traversal, files only, and a pure local file read (never a
      // paid/remote call), so it's safe to load on demand. "No artifact" is a
      // benign 200 { found: false } (not every item has produced output yet).
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workflow-runs' && parts[3] === 'output' && parts.length === 4) {
        const run = getWorkflowRun(parts[2]);
        if (!run) return json(res, 404, { error: 'workflow run not found' });
        const jobName = url.searchParams.get('job');
        const key = url.searchParams.get('key');
        if (!jobName || !key) return json(res, 400, { error: 'job and key query params are required' });
        const safe = safeOutputMarkdown(workItemMarkdownPath(jobName, key));
        if (!safe) return json(res, 200, { found: false, job: jobName, key });
        let content: string;
        try {
          content = readFileSync(safe, 'utf8');
        } catch {
          return json(res, 200, { found: false, job: jobName, key });
        }
        const MAX = 512 * 1024; // cap the payload; markdown profiles are tiny, this is a safety belt
        const truncated = content.length > MAX;
        return json(res, 200, {
          found: true,
          job: jobName,
          key,
          // A jobs-tree-relative path (e.g. perfumes/data/out/markdown/<id>.md) — readable, leaks no machine topology.
          file: relativePath(JOBS_ROOT, safe),
          bytes: Buffer.byteLength(content),
          truncated,
          content: truncated ? content.slice(0, MAX) : content,
        });
      }

      // GET /api/services  (usage vs caps + current per-minute rate)
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'services' && parts.length === 2) {
        const rows = listServices().map((s) => ({
          ...s,
          used_today: serviceCallsToday(s.name),
          used_month: serviceCallsThisMonth(s.name),
          rate_last_min: serviceCallsInLastSeconds(s.name, 60),
        }));
        return json(res, 200, { services: rows });
      }

      // POST /api/services/:name/limits  { rate_per_minute, daily_cap, monthly_cap }
      // Each value: a non-negative integer, or null (no throttle / no cap). User
      // override — persisted and preserved across code-sync.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'services' && parts[3] === 'limits') {
        const body = await readBody(req);
        const fields = ['rate_per_minute', 'daily_cap', 'monthly_cap'] as const;
        const limits: Record<string, number | null> = {};
        for (const f of fields) {
          const v = body[f];
          if (v === null || v === undefined || v === '') {
            limits[f] = null;
          } else if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
            limits[f] = v;
          } else {
            return json(res, 400, { error: `${f} must be a non-negative integer or null` });
          }
        }
        const updated = updateServiceLimits(parts[2], limits as unknown as {
          rate_per_minute: number | null; daily_cap: number | null; monthly_cap: number | null;
        });
        if (!updated) return json(res, 404, { error: 'service not found' });
        console.log(`[api] service ${parts[2]} limits updated:`, limits);
        return json(res, 200, { ok: true, service: updated });
      }

      // GET /api/services/:name/consumers — workflows + jobs that have called this service
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'services' && parts[3] === 'consumers') {
        const rows = listServiceConsumers(parts[2]);
        // Group by workflow for the dashboard view.
        const byWorkflow: Record<string, { workflow_name: string | null; jobs: { job_name: string; last_used: string }[] }> = {};
        for (const r of rows) {
          const wf = r.workflow_name ?? '__none__';
          if (!byWorkflow[wf]) byWorkflow[wf] = { workflow_name: r.workflow_name, jobs: [] };
          byWorkflow[wf].jobs.push({ job_name: r.job_name, last_used: r.last_used });
        }
        return json(res, 200, { consumers: Object.values(byWorkflow) });
      }

      // GET /api/db/tables — list the SQLite tables (read-only DB browser)
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'db' && parts[2] === 'tables' && parts.length === 3) {
        return json(res, 200, { tables: listDbTables() });
      }

      // GET /api/db/tables/:name?limit=&offset= — one page of rows, strictly
      // read-only (browseTable rejects unknown tables and runs only SELECT).
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'db' && parts[2] === 'tables' && parts.length === 4) {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const page = browseTable(parts[3], limit, offset);
        if (!page) return json(res, 404, { error: 'table not found' });
        return json(res, 200, page);
      }

      // GET /api/db/queries — the catalogue of canned read-only queries (metadata)
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'db' && parts[2] === 'queries' && parts.length === 3) {
        return json(res, 200, { queries: listCannedQueries() });
      }

      // GET /api/db/queries/:id — run one canned query by id (fixed SELECT only;
      // the id is the sole input and is matched against the fixed catalogue).
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'db' && parts[2] === 'queries' && parts.length === 4) {
        const result = runCannedQuery(parts[3]);
        if (!result) return json(res, 404, { error: 'query not found' });
        return json(res, 200, result);
      }

      // GET /api/backlog — the harness TASKS.json backlog (read-only). Each task's
      // human-review flag `reviewed` is OVERLAID from the owner-owned reviews store
      // (.harness/reviews.json, T136), defaulting to false when absent.
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'backlog' && parts.length === 2) {
        return json(res, 200, readBacklog(backlogPath, reviewsPath));
      }

      // POST /api/backlog/:id/reviewed  { reviewed: bool } — the ONE dashboard→harness
      // write (T136): atomically set ONLY this id's entry in the owner-owned reviews
      // store AND, under the SAME lock loop.sh uses, commit + push it `[skip ci]`. The
      // commit is the durability guarantee; the push is best-effort (a failed push is a
      // non-fatal `warning`, not an error). Guarded by the global loopback/token
      // mutation check above + a `T\d+`-style id validation. In-process POSTs are
      // serialized so two requests can't interleave the write+commit.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'backlog' && parts[3] === 'reviewed' && parts.length === 4) {
        const id = decodeURIComponent(parts[2]);
        if (!/^T\d+$/.test(id)) return json(res, 400, { error: 'invalid task id' });
        const body = await readBody(req);
        if (typeof body.reviewed !== 'boolean') return json(res, 400, { error: 'reviewed (boolean) is required' });
        const reviewed = body.reviewed as boolean;
        const result = await serializeReview(async () => {
          writeReviewEntry(reviewsPath, id, reviewed, new Date().toISOString());
          return commitReviews(reviewsPath, id, reviewed);
        });
        return json(res, 200, {
          ok: true,
          id,
          reviewed,
          committed: result.committed,
          pushed: result.pushed,
          ...(result.warning ? { warning: result.warning } : {}),
        });
      }

      // POST /api/backlog/reviewed-bulk  { ids: string[] } — bulk mark-reviewed:
      // writes ALL ids to reviews.json in ONE atomic disk write and produces exactly
      // ONE git commit for the whole batch (not N). Behind the same loopback/token
      // guard as the per-task endpoint; serialized via the same in-process mutex so
      // concurrent POSTs can't interleave. Always marks reviewed=true (un-review is
      // a no-op via the per-task endpoint for the single case; there is no bulk un-review).
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'backlog' && parts[2] === 'reviewed-bulk' && parts.length === 3) {
        const body = await readBody(req);
        const ids = body.ids;
        if (!Array.isArray(ids) || ids.length === 0 || ids.some((x: unknown) => typeof x !== 'string' || !/^T\d+$/.test(x as string))) {
          return json(res, 400, { error: 'ids must be a non-empty array of T\\d+ strings' });
        }
        const validIds = ids as string[];
        const result = await serializeReview(async () => {
          writeReviewEntries(reviewsPath, validIds, true, new Date().toISOString());
          return commitReviewsBulk(reviewsPath, validIds);
        });
        return json(res, 200, {
          ok: true,
          ids: validIds,
          count: validIds.length,
          committed: result.committed,
          pushed: result.pushed,
          ...(result.warning ? { warning: result.warning } : {}),
        });
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('[api] error', err);
      return json(res, 500, { error: err instanceof Error ? err.message : 'internal error' });
    }
  });
}

export function startApi(): void {
  const server = createApiServer();
  server.listen(config.apiPort, config.apiHost, () => {
    console.log(`[api] listening on http://${config.apiHost}:${config.apiPort}`);
  });
}
