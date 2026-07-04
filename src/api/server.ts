import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join as joinPath, relative as relativePath, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { acquireRepoLock, resolveRepoPaths } from '../core/repo-lock.js';
import { type Gate, buildDag, classifyGates, deriveGates, shapesIdentical } from '../core/dag.js';
import type { GateResult } from '../core/types.js';
import { runWorkflow, cancelWorkflowRun, workflowRunInProgress, effectiveWorkflowConcurrency, DEFAULT_WORKFLOW_CONCURRENCY, effectiveWorkflowNotifyEnabled } from '../core/workflow-executor.js';
import { nextWorkflowRun, rescheduleWorkflow } from '../core/scheduler.js';
import { Cron } from 'croner';
import { getJobDefinition, getWorkflowDefinition } from '../jobs/registry.js';
import { moviesConfig } from '../jobs/movies/config.js';
import { NOTIFY_JOB as MOVIE_GAPS_JOB, gapKey } from '../jobs/movies/stages/notify.js';
import { RECS_JOB, recKey } from '../jobs/movies/recs.js';
import type { FranchiseGapsFile, RecommendationsFile } from '../jobs/movies/types.js';
import { tvRecsConfig } from '../jobs/tv-recs/config.js';
import { RECS_JOB as TV_RECS_JOB, recKey as tvRecKey } from '../jobs/tv-recs/recs.js';
import type { RecommendationsFile as TvRecommendationsFile } from '../jobs/tv-recs/types.js';
import { plexConfig } from '../jobs/plex/config.js';
import { NOTIFY_JOB as PLEX_SEASONS_JOB, pairKey } from '../jobs/plex/stages/notify.js';
import type { MissingSeasonsFile } from '../jobs/plex/types.js';
import {
  getLogs,
  listGlobalLogs,
  getWorkflow,
  getWorkflowJobs,
  getWorkflowLogs,
  getWorkItem,
  getWorkflowRun,
  getRun,
  lastWorkflowRunForWorkflow,
  lastRunForJob,
  listJobs,
  updateJobTimeout,
  listWorkflowRunsForWorkflow,
  listWorkflows,
  listRecentWorkflowRuns,
  listRecentRuns,
  listRunsForJob,
  listRunsForWorkflowRun,
  listServices,
  orphanedWorkItems,
  pruneOrphanedWorkItems,
  resetWorkflowOutput,
  workItemIoRows,
  stageIoLists,
  workflowHasRunLinkage,
  workItemMarkdownPath,
  workflowTerminalItems,
  type OutputItem,
  serviceCallsInLastSeconds,
  serviceCallsThisMonth,
  serviceCallsToday,
  updateServiceLimits,
  listServiceConsumers,
  setWorkflowEnabled,
  updateWorkflowSchedule,
  updateWorkflowConcurrency,
  updateWorkflowNotifyEnabled,
  stuckCount,
  stuckItems,
  unstickWorkItem,
  ignoreWorkItem,
  ignoreSurfacedItem,
  ignoreSurfacedItems,
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

// The real .harness/ directory (T329) — the anchor for tasks/, worklog/, and ledgers/,
// which do NOT move even though the backlog + overlay files below live one level deeper
// in .harness/tracking/. Kept SEPARATE from BACKLOG_PATH's own directory on purpose: see
// readBacklog's `harnessDir` param.
const HARNESS_DIR = fileURLToPath(new URL('../../.harness/', import.meta.url));

// The harness backlog (.harness/tracking/TASKS.json, moved off the .harness/ top level
// in T329 alongside the overlay files below), resolved relative to this file so it works
// regardless of the daemon's cwd. This is a READ-ONLY pass-through for the dashboard —
// the loop owns `status`, and the human-owned `reviewed` flag now lives in its OWN
// owner-owned file (`.harness/tracking/reviews.json`, T136), NOT in TASKS.json.
const BACKLOG_PATH = fileURLToPath(new URL('../../.harness/tracking/TASKS.json', import.meta.url));

// The owner-owned reviews store (T136). `reviewed` is the ONE human/dashboard-owned
// piece of backlog state, and it is the SOLE source of truth here — it no longer
// lives in TASKS.json (which the loop owns). The file is a committed JSON map
// `id → { reviewed: bool, at: ISO-8601 }`. `POST /api/backlog/:id/reviewed`
// atomically writes it AND, under the SAME lock loop.sh uses, commits + pushes it
// (see `commitReviewsFile`). Because reviews.json is a DISJOINT git path from
// everything the loop commits (TASKS.json / worklog), the two writers never conflict.
const REVIEWS_PATH = fileURLToPath(new URL('../../.harness/tracking/reviews.json', import.meta.url));

// The owner-owned human-done store (T208). `done` records that a needs-human task
// was completed by the owner. The file is a committed JSON map
// `id → { done: true, at: ISO-8601 }`. `POST /api/backlog/:id/done` atomically
// writes it AND commits+pushes under the SAME lock. Marking done implies reviewed.
const HUMAN_DONE_PATH = fileURLToPath(new URL('../../.harness/tracking/human-done.json', import.meta.url));

// The owner-owned manual-fail store (manual-fail-signal). `failed` records that the
// owner judged a DONE task to have actually failed. The file is a committed JSON map
// `id → { failed: true, reason, at: ISO-8601 }`. `POST /api/backlog/:id/failed`
// atomically writes it AND commits+pushes under the SAME lock. The loop NEVER writes
// it; it only READS it to correct calibration (re-count the task as a failure for tier
// tuning + drop it from the cell's audited-success count). Disjoint git path, so it
// never conflicts with the loop. Marking failed implies reviewed (the owner looked).
const MANUAL_FAIL_PATH = fileURLToPath(new URL('../../.harness/tracking/manual-fail.json', import.meta.url));

/** Default the reviews-store path to sit beside a given backlog file. */
function reviewsPathFor(backlogPath: string): string {
  return joinPath(dirname(backlogPath), 'reviews.json');
}

/** Default the human-done-store path to sit beside a given backlog file. */
function humanDonePathFor(backlogPath: string): string {
  return joinPath(dirname(backlogPath), 'human-done.json');
}

/** Default the manual-fail-store path to sit beside a given backlog file. */
function manualFailPathFor(backlogPath: string): string {
  return joinPath(dirname(backlogPath), 'manual-fail.json');
}

/**
 * Read a task's Markdown spec (its `## Do` / `## Done when` sections — the SOLE
 * source of do/doneWhen since T131). `specRel` is the JSON `spec` path, relative
 * to the repo root; `harnessDir` is the REAL `.harness/` directory (which directly
 * contains `tasks/` — NOT the backlog file's own directory, since T329 moved
 * `TASKS.json` into `.harness/tracking/`) so it resolves the same regardless of
 * cwd. Confined to a `.harness/tasks/*.md` file (no traversal, markdown only) — a
 * local file read, never a network/paid call. Returns the file text, or null if
 * the field is absent / unreadable / outside the allowed dir.
 */
export function readTaskSpec(specRel: unknown, harnessDir: string): string | null {
  if (typeof specRel !== 'string' || !specRel) return null;
  // The repo root is .harness/'s parent.
  const repoRoot = dirname(harnessDir);
  const abs = resolvePath(repoRoot, specRel);
  if (!abs.toLowerCase().endsWith('.md')) return null;
  const tasksDir = joinPath(harnessDir, 'tasks');
  if (!isWithin(tasksDir, abs)) return null; // must live under .harness/tasks/
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Read a task's committed worklog (`.harness/worklog/<id>.md`). `id` must be a
 * plain task id string; `harnessDir` is the REAL `.harness/` directory (see
 * `readTaskSpec`'s doc comment — NOT the backlog file's own directory). Confined
 * to `.harness/worklog/*.md` (no traversal, markdown only). Returns the file
 * text, or null when the file is absent or the id fails the safety check.
 */
export function readWorklogContent(id: unknown, harnessDir: string): string | null {
  if (typeof id !== 'string' || !id || id.includes('/') || id.includes('..') || !id.match(/^[\w-]+$/)) return null;
  const worklogDir = joinPath(harnessDir, 'worklog');
  const abs = joinPath(worklogDir, `${id}.md`);
  if (!isWithin(worklogDir, abs)) return null; // belt-and-suspenders
  if (!abs.toLowerCase().endsWith('.md')) return null;
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Aggregated build-attempt failure history for a task (`.harness/ledgers/failures.jsonl`, T294). */
export interface TaskBuildFailures {
  count: number;
  latestKind: string;
  latestDetail: string;
  latestAt: string;
}

/**
 * Read `.harness/ledgers/failures.jsonl` (JSON-Lines; one loop-recorded build-attempt row per
 * line) and aggregate the rows matching `id`. `id` must be a plain task id string;
 * `harnessDir` is the REAL `.harness/` directory (see `readTaskSpec`'s doc comment — NOT the
 * backlog file's own directory), so the file is confined to `.harness/ledgers/failures.jsonl`
 * (no traversal). Returns `null` when the file is absent, unreadable, or has no matching rows.
 */
export function readTaskBuildFailures(id: unknown, harnessDir: string): TaskBuildFailures | null {
  if (typeof id !== 'string' || !id || id.includes('/') || id.includes('..') || !id.match(/^[\w-]+$/)) return null;
  const abs = joinPath(harnessDir, 'ledgers', 'failures.jsonl');
  if (!isWithin(harnessDir, abs)) return null; // belt-and-suspenders
  let raw: string;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  let latest: { ts?: unknown; kind?: unknown; detail?: unknown } | null = null;
  let count = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: { id?: unknown; ts?: unknown; kind?: unknown; detail?: unknown };
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (row.id !== id) continue;
    count += 1;
    if (!latest || (typeof row.ts === 'string' && (typeof latest.ts !== 'string' || row.ts > latest.ts))) {
      latest = row;
    }
  }
  if (count === 0 || !latest) return null;
  return {
    count,
    latestKind: typeof latest.kind === 'string' ? latest.kind : '',
    latestDetail: typeof latest.detail === 'string' ? latest.detail : '',
    latestAt: typeof latest.ts === 'string' ? latest.ts : '',
  };
}

/** An entry in the owner-owned reviews store (`.harness/tracking/reviews.json`, T136). */
export interface ReviewEntry {
  reviewed: boolean;
  at?: string;
}

/** An entry in the owner-owned human-done store (`.harness/tracking/human-done.json`, T208). */
export interface HumanDoneEntry {
  done: boolean;
  at?: string;
}

/**
 * Read the human-done store (`id → { done, at }`). Returns `{}` when the file is
 * absent, empty, or unparseable. Exported for unit testing.
 */
export function readHumanDone(path: string = HUMAN_DONE_PATH): Record<string, HumanDoneEntry> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, HumanDoneEntry>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Pure, field-scoped edit of the human-done-store TEXT: parse `raw` (may be empty →
 * treated as `{}`), set ONLY the entry for `id` to `{ done: true, at }`, and return
 * the re-serialised JSON. Every other id is preserved. Exported for unit testing.
 */
export function setHumanDoneEntry(raw: string, id: string, at: string): string {
  let map: Record<string, HumanDoneEntry> = {};
  if (raw.trim()) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed as Record<string, HumanDoneEntry>;
  }
  map[id] = { done: true, at };
  return `${JSON.stringify(map, null, 2)}\n`;
}

/**
 * Atomically persist a single id's human-done entry. Reads the current file
 * (absent → `{}`), applies the field-scoped edit, validates, then temp-file + rename.
 */
function writeHumanDoneEntry(path: string, id: string, at: string): void {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    raw = '';
  }
  const updated = setHumanDoneEntry(raw, id, at);
  JSON.parse(updated); // validate before we touch disk
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, updated);
  renameSync(tmp, path); // atomic replace
}

export interface ManualFailEntry {
  failed: boolean;
  reason?: string;
  at?: string;
}

/**
 * Read the manual-fail store (`id → { failed, reason, at }`). Returns `{}` when the
 * file is absent, empty, or unparseable. Exported for unit testing.
 */
export function readManualFail(path: string = MANUAL_FAIL_PATH): Record<string, ManualFailEntry> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, ManualFailEntry>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Pure, field-scoped edit of the manual-fail-store TEXT: parse `raw` (may be empty →
 * treated as `{}`); when `failed` is true set ONLY this id to `{ failed: true, reason, at }`,
 * when false DELETE this id (undo). Every other id is preserved. Exported for unit testing.
 */
export function setManualFailEntry(raw: string, id: string, failed: boolean, reason: string, at: string): string {
  let map: Record<string, ManualFailEntry> = {};
  if (raw.trim()) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed as Record<string, ManualFailEntry>;
  }
  if (failed) map[id] = { failed: true, reason, at };
  else delete map[id];
  return `${JSON.stringify(map, null, 2)}\n`;
}

/**
 * Atomically persist a single id's manual-fail entry (or remove it when failed=false).
 * Reads the current file (absent → `{}`), applies the field-scoped edit, validates,
 * then temp-file + rename.
 */
function writeManualFailEntry(path: string, id: string, failed: boolean, reason: string, at: string): void {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    raw = '';
  }
  const updated = setManualFailEntry(raw, id, failed, reason, at);
  JSON.parse(updated); // validate before we touch disk
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, updated);
  renameSync(tmp, path); // atomic replace
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
 * Read the backlog and OVERLAY the owner-owned reviews store (T136) and human-done
 * store (T208): each task's `reviewed` is `reviews[id]?.reviewed ?? false`, and
 * `done` is `humanDone[id]?.done ?? false`. When `done` is true, `reviewed` is
 * also forced true (done implies reviewed). Also inlines each task's Markdown spec
 * content (`spec` → `specContent`, T131).
 *
 * `harnessDir` is the directory that DIRECTLY contains `tasks/`, `worklog/`, and
 * `ledgers/` — since T329 this is NO LONGER always `dirname(path)` (the backlog file
 * itself lives one level deeper, in `.harness/tracking/`), so it's threaded through
 * separately rather than derived from the backlog path.
 */
function readBacklog(
  path: string = BACKLOG_PATH,
  reviewsPath: string = reviewsPathFor(path),
  humanDonePath: string = humanDonePathFor(path),
  manualFailPath: string = manualFailPathFor(path),
  harnessDir: string = HARNESS_DIR,
): { tasks: unknown[]; error?: string } {
  try {
    const reviews = readReviews(reviewsPath);
    const humanDone = readHumanDone(humanDonePath);
    const manualFail = readManualFail(manualFailPath);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { tasks?: unknown[] };
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks.map((t) => {
          if (!(t && typeof t === 'object' && !Array.isArray(t))) return t;
          const task = t as { id?: unknown; spec?: unknown };
          const specContent = readTaskSpec(task.spec, harnessDir);
          const worklogContent = readWorklogContent(task.id, harnessDir);
          const buildFailures = readTaskBuildFailures(task.id, harnessDir);
          const isDone = typeof task.id === 'string' ? humanDone[task.id]?.done === true : false;
          const failEntry = typeof task.id === 'string' ? manualFail[task.id] : undefined;
          const failed = failEntry?.failed === true;
          // A manually-failed task counts as reviewed (the owner looked to fail it), like done.
          const reviewed = isDone || failed || (typeof task.id === 'string' ? reviews[task.id]?.reviewed === true : false);
          return {
            ...(t as object),
            reviewed,
            ...(isDone ? { done: true } : {}),
            ...(failed ? { failed: true, ...(failEntry?.reason ? { failReason: failEntry.reason } : {}) } : {}),
            ...(specContent !== null ? { specContent } : {}),
            ...(worklogContent !== null ? { worklogContent } : {}),
            ...(buildFailures !== null ? { buildFailures } : {}),
          };
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

async function defaultCommitHumanDone(humanDonePath: string, id: string): Promise<CommitReviewsResult> {
  let repoRoot: string;
  try {
    repoRoot = resolveRepoPaths(dirname(humanDonePath)).root;
  } catch {
    return { committed: false, pushed: false, warning: 'not a git repo — wrote locally only' };
  }
  try {
    return await commitReviewsFile({
      repoRoot,
      reviewsAbsPath: humanDonePath,
      id,
      reviewed: true,
      commitMessage: `human-done: ${id} done [skip ci]`,
    });
  } catch (e) {
    return { committed: false, pushed: false, warning: e instanceof Error ? e.message : 'commit failed' };
  }
}

async function defaultCommitManualFail(manualFailPath: string, id: string, failed: boolean): Promise<CommitReviewsResult> {
  let repoRoot: string;
  try {
    repoRoot = resolveRepoPaths(dirname(manualFailPath)).root;
  } catch {
    return { committed: false, pushed: false, warning: 'not a git repo — wrote locally only' };
  }
  try {
    return await commitReviewsFile({
      repoRoot,
      reviewsAbsPath: manualFailPath,
      id,
      reviewed: failed,
      commitMessage: failed ? `manual-fail: ${id} [skip ci]` : `manual-fail: clear ${id} [skip ci]`,
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
 * Scan JOBS_ROOT for `*.workflow.ts` / `*.workflow.js` files, import each one
 * (cached by the module system from registry startup), and return the containing
 * directory when the exported workflow name matches `workflowName`. Returns null
 * if no matching workflow file is found.
 *
 * Used by the reset-output endpoint to locate the workflow's `data/out/` tree.
 * Imports are cheap (already cached) — this is a filesystem walk + map-lookup.
 */
export async function findWorkflowDataOut(workflowName: string): Promise<string | null> {
  const isWfFile = (f: string) => f.endsWith('.workflow.ts') || f.endsWith('.workflow.js');
  function walkForWfFiles(dir: string): string[] {
    const out: string[] = [];
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = joinPath(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkForWfFiles(full));
        else if (isWfFile(entry.name)) out.push(full);
      }
    } catch { /* skip unreadable dirs */ }
    return out;
  }
  for (const file of walkForWfFiles(JOBS_ROOT)) {
    try {
      const mod = await import(pathToFileURL(file).href) as { default?: { name?: string } };
      if (mod.default?.name === workflowName) {
        const candidate = joinPath(dirname(file), 'data', 'out');
        // Validate the candidate is within JOBS_ROOT (it always should be, but be explicit).
        if (!isWithin(JOBS_ROOT, resolvePath(candidate))) return null;
        return existsSync(candidate) ? candidate : null;
      }
    } catch { /* skip import errors */ }
  }
  return null;
}

/**
 * Delete all children of `outDir` without removing the directory itself.
 * Validates that `outDir` is within JOBS_ROOT and contains `data/out` in its
 * path before touching anything. Returns the number of top-level entries removed.
 * Safe to call when the directory doesn't exist (returns 0). Exported for testing.
 */
export function deleteDataOutContents(outDir: string): number {
  if (!isWithin(JOBS_ROOT, resolvePath(outDir))) return 0; // safety: must stay within jobs tree
  if (!outDir.includes(`${sep}data${sep}out`)) return 0;   // safety: must be a data/out dir
  let removed = 0;
  try {
    for (const entry of readdirSync(outDir)) {
      rmSync(joinPath(outDir, entry), { recursive: true, force: true });
      removed++;
    }
  } catch { /* directory doesn't exist or is unreadable — no-op */ }
  return removed;
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
 * Resolve a job-recorded output path to a safe, real, absolute path — or null if
 * it isn't a readable artifact inside a job's `data/out/` tree. Like
 * {@link safeOutputMarkdown} but without the `.md` extension restriction, so any
 * file format stored under `data/out/` is allowed. All other guards are identical:
 *  - resolved + symlink-followed (realpath) so `..`/symlink escapes are caught,
 *  - must stay under {@link JOBS_ROOT},
 *  - must live inside a job-local `data/out/` directory,
 *  - must be a regular file that exists.
 * No network/paid calls — a local file stat + realpath only.
 *
 * Use this for declared non-markdown output forms (see Output-form convention in
 * CLAUDE.md). For the `markdown` form continue using {@link safeOutputMarkdown}.
 */
export function safeOutputFile(candidate: string | null): string | null {
  if (!candidate) return null;
  const abs = resolvePath(candidate);
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
 * Read the output form declared in a work item's `detail.format` field, and return
 * the file path to serve. Convention (see CLAUDE.md Output-form convention):
 *  - `format === 'markdown'` or unset → serve `detail.markdown` via safeOutputMarkdown
 *  - any other format → serve `detail.path` via safeOutputFile
 * Returns `{ format, path }` where `path` is null when no artifact is declared.
 */
function resolveOutputForm(jobName: string, itemKey: string): { format: string; path: string | null } {
  const row = getWorkItem(jobName, itemKey);
  if (!row?.detail) return { format: 'markdown', path: workItemMarkdownPath(jobName, itemKey) };
  let detail: Record<string, unknown>;
  try {
    detail = JSON.parse(row.detail) as Record<string, unknown>;
  } catch {
    return { format: 'markdown', path: null };
  }
  const format = typeof detail.format === 'string' && detail.format ? detail.format : 'markdown';
  if (format === 'markdown') {
    return { format, path: typeof detail.markdown === 'string' && detail.markdown ? detail.markdown : null };
  }
  return { format, path: typeof detail.path === 'string' && detail.path ? detail.path : null };
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
    humanDonePath?: string;
    manualFailPath?: string;
    // The REAL .harness/ directory (directly containing tasks/worklog/ledgers) — see
    // readBacklog's doc comment. Defaults to production HARNESS_DIR; tests that model
    // .harness/ as a flat temp dir (backlogPath + tasks/ + worklog/ + ledgers/ all
    // siblings) override this to that same temp dir.
    harnessDir?: string;
    // Injectable for tests: commit+push the reviews file. Defaults to the real git
    // path (resolves the repo from the reviews dir; no-ops outside a git repo).
    commitReviews?: (reviewsPath: string, id: string, reviewed: boolean) => Promise<CommitReviewsResult>;
    commitReviewsBulk?: (reviewsPath: string, ids: string[]) => Promise<CommitReviewsResult>;
    commitHumanDone?: (humanDonePath: string, id: string) => Promise<CommitReviewsResult>;
    commitManualFail?: (manualFailPath: string, id: string, failed: boolean) => Promise<CommitReviewsResult>;
  } = {},
) {
  const isLoopback = opts.isLoopback ?? isLoopbackAddress;
  const backlogPath = opts.backlogPath ?? BACKLOG_PATH;
  const reviewsPath = opts.reviewsPath ?? reviewsPathFor(backlogPath);
  const humanDonePath = opts.humanDonePath ?? humanDonePathFor(backlogPath);
  const manualFailPath = opts.manualFailPath ?? manualFailPathFor(backlogPath);
  const harnessDir = opts.harnessDir ?? HARNESS_DIR;
  const commitReviews = opts.commitReviews ?? defaultCommitReviews;
  const commitReviewsBulk = opts.commitReviewsBulk ?? defaultCommitReviewsBulk;
  const commitHumanDone = opts.commitHumanDone ?? defaultCommitHumanDone;
  const commitManualFail = opts.commitManualFail ?? defaultCommitManualFail;
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

      // GET /api/logs  — global cross-cutting log feed (job + workflow logs merged, newest first)
      // ?level=info,warn,error  ?job=<name>  ?workflow=<name>  ?q=<substring>  ?windowHours=  ?before=<cursor>  ?limit=
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'logs' && parts.length === 2) {
        const jobFilter = url.searchParams.get('job') ?? undefined;
        const wfFilter = url.searchParams.get('workflow') ?? undefined;
        if (jobFilter && wfFilter) {
          return json(res, 400, { error: 'job and workflow filters are mutually exclusive' });
        }
        const levelParam = url.searchParams.get('level');
        let levels: ('info' | 'warn' | 'error')[] | undefined;
        if (levelParam) {
          const raw = levelParam.split(',').map((s) => s.trim()).filter(Boolean);
          for (const lvl of raw) {
            if (lvl !== 'info' && lvl !== 'warn' && lvl !== 'error') {
              return json(res, 400, { error: `invalid level "${lvl}"` });
            }
          }
          levels = raw as ('info' | 'warn' | 'error')[];
        }
        const q = url.searchParams.get('q') ?? undefined;
        const windowHoursParam = url.searchParams.get('windowHours');
        const windowHours = windowHoursParam != null ? Number(windowHoursParam) : 24;
        const before = url.searchParams.get('before') ?? undefined;
        const limitParam = url.searchParams.get('limit');
        let limit = limitParam != null ? Number(limitParam) : 200;
        if (!Number.isFinite(limit)) limit = 200;
        limit = Math.max(1, Math.min(500, Math.floor(limit)));
        const result = listGlobalLogs({ levels, job: jobFilter, workflow: wfFilter, q, windowHours, before, limit });
        return json(res, 200, result);
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

      // POST /api/movie-gaps/ignore-bulk { tmdbIds: number[] } — bulk-ignore a set
      // of franchise gap items (e.g. all items in a collection). Only the exact
      // tmdbIds supplied are ignored; no collection-level flag is persisted so a new
      // gap appearing later for the same collection will surface fresh. Guarded by
      // the global loopback/token mutation check. Idempotent.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'movie-gaps' && parts[2] === 'ignore-bulk') {
        const body: { tmdbIds?: unknown } = await readBody(req).catch(() => ({}));
        const ids = body.tmdbIds;
        if (!Array.isArray(ids) || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
          return json(res, 400, { error: 'tmdbIds must be an array of positive integers' });
        }
        const keys = (ids as number[]).map((id) => gapKey(id));
        const ignored = ignoreSurfacedItems(MOVIE_GAPS_JOB, keys);
        return json(res, 200, { ok: true, ignored });
      }

      // GET /api/movie-recs — the current recommendations (read from the movies
      // workflow's recommendations.json), each overlaid with its ledger status:
      // `notified` (already digested) and `ignored` (owner-suppressed). Read-only,
      // file + DB only — never a paid/remote call. Returns an empty list (not an
      // error) when the workflow hasn't produced recommendations yet.
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'movie-recs' && parts.length === 2) {
        let file: RecommendationsFile = { generatedAt: '', pooled: 0, recommendations: [] };
        try {
          file = JSON.parse(readFileSync(moviesConfig.recsOut, 'utf8')) as RecommendationsFile;
        } catch {
          // recommendations.json not yet written — return an empty list.
        }
        const ignoredKeys = ignoredItemKeys(RECS_JOB);
        const recs = (file.recommendations ?? []).map((r) => {
          const key = recKey(r.tmdbId);
          return {
            ...r,
            ignored: ignoredKeys.has(key),
            notified: isWorkItemDone(RECS_JOB, key, 1) && !ignoredKeys.has(key),
          };
        });
        return json(res, 200, {
          generatedAt: file.generatedAt || null,
          pooled: file.pooled ?? 0,
          recommendations: recs,
        });
      }

      // POST /api/movie-recs/:tmdbId/ignore — owner manually IGNORES a recommendation
      // so it leaves future reports AND notifications and never resurfaces. Manual only;
      // guarded by the global loopback/token mutation check above. Idempotent.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'movie-recs' && parts[3] === 'ignore') {
        const tmdbId = Number(parts[2]);
        if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
          return json(res, 400, { error: 'tmdbId must be a positive integer' });
        }
        const ignored = ignoreSurfacedItem(RECS_JOB, recKey(tmdbId));
        return json(res, 200, { ok: true, ignored });
      }

      // GET /api/tv-recs — the current TV recommendations (read from the tv-recs
      // workflow's recommendations.json), each overlaid with its ledger status:
      // `notified` (already digested) and `ignored` (owner-suppressed). Read-only,
      // file + DB only — never a paid/remote call. Returns an empty list (not an
      // error) when the workflow hasn't produced recommendations yet.
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'tv-recs' && parts.length === 2) {
        let file: TvRecommendationsFile = { generatedAt: '', pooled: 0, recommendations: [] };
        try {
          file = JSON.parse(readFileSync(tvRecsConfig.recsOut, 'utf8')) as TvRecommendationsFile;
        } catch {
          // recommendations.json not yet written — return an empty list.
        }
        const ignoredKeys = ignoredItemKeys(TV_RECS_JOB);
        const recs = (file.recommendations ?? []).map((r) => {
          const key = tvRecKey(r.tmdbId);
          return {
            ...r,
            ignored: ignoredKeys.has(key),
            notified: isWorkItemDone(TV_RECS_JOB, key, 1) && !ignoredKeys.has(key),
          };
        });
        return json(res, 200, {
          generatedAt: file.generatedAt || null,
          pooled: file.pooled ?? 0,
          recommendations: recs,
        });
      }

      // POST /api/tv-recs/:tmdbId/ignore — owner manually IGNORES a TV recommendation
      // so it leaves future reports AND notifications and never resurfaces. Manual only;
      // guarded by the global loopback/token mutation check above. Idempotent.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'tv-recs' && parts[3] === 'ignore') {
        const tmdbId = Number(parts[2]);
        if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
          return json(res, 400, { error: 'tmdbId must be a positive integer' });
        }
        const ignored = ignoreSurfacedItem(TV_RECS_JOB, tvRecKey(tmdbId));
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

      // POST /api/missing-seasons/ignore-bulk { items: { tmdbId, season }[] } —
      // bulk-ignore a set of season gaps (e.g. all seasons for a show). Only the
      // exact items supplied are ignored; a new season appearing in a later run for
      // the same show will surface fresh. Guarded by the global loopback/token
      // mutation check. Idempotent.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'missing-seasons' && parts[2] === 'ignore-bulk') {
        const body: { items?: unknown } = await readBody(req).catch(() => ({}));
        const items = body.items;
        if (
          !Array.isArray(items) ||
          items.some(
            (it) =>
              typeof it !== 'object' ||
              it === null ||
              !Number.isInteger((it as Record<string, unknown>).tmdbId) ||
              ((it as Record<string, unknown>).tmdbId as number) <= 0 ||
              !Number.isInteger((it as Record<string, unknown>).season) ||
              ((it as Record<string, unknown>).season as number) <= 0,
          )
        ) {
          return json(res, 400, { error: 'items must be an array of { tmdbId, season } objects with positive integers' });
        }
        const keys = (items as { tmdbId: number; season: number }[]).map((it) => pairKey(it.tmdbId, it.season));
        const ignored = ignoreSurfacedItems(PLEX_SEASONS_JOB, keys);
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

      // POST /api/jobs/:name/timeout  { timeoutMs }
      // Persist a USER override of the job's `timeoutMs` (T297) — mirrors the
      // workflow schedule/maxConcurrency overrides, but scoped to a JOB row: unlike
      // schedule/enabled (workflow-only, T070), timeoutMs is a genuinely job-scoped
      // execution parameter. The executor already reads the DB row's value in
      // preference to the manifest constant, so no executor change is needed for
      // the override to take effect on the next run. Guarded by the same
      // loopback/token mutation check as /toggle, /run, /schedule, /concurrency.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'jobs' && parts[3] === 'timeout') {
        const jobName = parts[2];
        const body = await readBody(req);
        const timeoutMs = body.timeoutMs;
        if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 0) {
          return json(res, 400, { error: 'timeoutMs must be a non-negative integer (milliseconds)' });
        }
        const updated = updateJobTimeout(jobName, timeoutMs);
        if (!updated) return json(res, 404, { error: 'job not found' });
        return json(res, 200, { ok: true, job: updated });
      }

      // NOTE: there is intentionally NO POST /api/jobs/:name/toggle (T070). The
      // enable toggle lives on the workflow (POST /api/workflows/:name/toggle) —
      // a job has no enabled flag of its own.

      // GET /api/workflows
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workflows' && parts.length === 2) {
        const rows = listWorkflows().map((p) => {
          const wfDef = getWorkflowDefinition(p.name);
          const effective_notify_enabled = wfDef ? effectiveWorkflowNotifyEnabled(wfDef) : p.notify_enabled !== 0;
          return { ...p, effective_notify_enabled, ...workflowView(p.name) };
        });
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
        // Effective notify-enabled (T285): the user override / synced manifest value /
        // default true — the same value runWorkflow gates the aggregate notification on.
        const effective_notify_enabled = wfDef ? effectiveWorkflowNotifyEnabled(wfDef) : p.notify_enabled !== 0;
        return json(res, 200, { workflow: { ...p, effective_max_concurrency, effective_notify_enabled, ...workflowView(p.name), gates: gatesForWorkflow(p.name), runs: listWorkflowRunsForWorkflow(p.name, 20) } });
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

      // GET /api/workflows/:name/output-items  (T205)
      // Return the terminal-stage work items with status='success', de-duped by
      // (job_name, item_key). Powers the unified Output section on every workflow's
      // detail page — items are naturally de-duped because the ledger has a UNIQUE
      // key per (job_name, item_key). Read-only, DB only, no paid/remote calls.
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workflows' && parts[3] === 'output-items' && parts.length === 4) {
        const name = parts[2];
        const refs = getWorkflowJobs(name).map((m) => ({ job: m.job_name, dependsOn: m.depends_on }));
        if (refs.length === 0) return json(res, 200, { items: [] as OutputItem[], terminalJobs: [] as string[] });
        let lastWave: string[] = [];
        try {
          const dag = buildDag(refs);
          lastWave = dag.waves[dag.waves.length - 1] ?? [];
        } catch {
          return json(res, 200, { items: [] as OutputItem[], terminalJobs: [] as string[] });
        }
        const def = getWorkflowDefinition(name);
        const outputJobs =
          def?.outputJob && refs.some((r) => r.job === def.outputJob) ? [def.outputJob] : lastWave;
        return json(res, 200, { items: workflowTerminalItems(outputJobs), terminalJobs: outputJobs });
      }

      // GET /api/workflows/:name/output?job=&key=  (T205)
      // Return the artifact for one workflow output item, not scoped to a specific run.
      // Dispatches on the item's declared output form (detail.format — see CLAUDE.md
      // Output-form convention). The `markdown` form (or unset) uses safeOutputMarkdown
      // (must end .md + inside data/out/). Any other declared form uses safeOutputFile
      // (same guards, no .md restriction). Both confine reads to data/out/ trees.
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workflows' && parts[3] === 'output' && parts.length === 4) {
        const jobName = url.searchParams.get('job');
        const key = url.searchParams.get('key');
        if (!jobName || !key) return json(res, 400, { error: 'job and key query params are required' });
        const { format, path: candidatePath } = resolveOutputForm(jobName, key);
        const safe = format === 'markdown' ? safeOutputMarkdown(candidatePath) : safeOutputFile(candidatePath);
        if (!safe) return json(res, 200, { found: false, job: jobName, key, format });
        let content: string;
        try {
          content = readFileSync(safe, 'utf8');
        } catch {
          return json(res, 200, { found: false, job: jobName, key, format });
        }
        const MAX = 512 * 1024;
        const truncated = content.length > MAX;
        return json(res, 200, {
          found: true,
          job: jobName,
          key,
          format,
          file: relativePath(JOBS_ROOT, safe),
          bytes: Buffer.byteLength(content),
          truncated,
          content: truncated ? content.slice(0, MAX) : content,
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

      // POST /api/workflows/:name/notify  { notifyEnabled }
      // Persist a USER override of whether the workflow sends the run-end aggregate
      // push notification (T285). Mirrors the concurrency override: user-owned +
      // code-reconciled (via `notify_enabled_overridden`, like `enabled`/`schedule`/
      // `max_concurrency`). `runWorkflow` reads the effective value FRESH each run, so
      // a toggle takes effect on the NEXT run with no daemon restart. The body MUST be
      // a boolean — else 400. Unknown workflow → 404. Mutating, so it goes through the
      // same loopback/token guard as /toggle, /run, /schedule, /concurrency, /limits.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workflows' && parts[3] === 'notify') {
        const name = parts[2];
        if (!getWorkflow(name)) return json(res, 404, { error: 'workflow not found' });
        const body = await readBody(req);
        if (typeof body.notifyEnabled !== 'boolean') {
          return json(res, 400, { error: 'notifyEnabled must be a boolean' });
        }
        updateWorkflowNotifyEnabled(name, body.notifyEnabled);
        return json(res, 200, { ok: true, notify_enabled: body.notifyEnabled });
      }

      // POST /api/workflows/reset-output-all
      // Bulk variant of reset-output (T322): runs the SAME per-workflow reset across
      // EVERY workflow in one call. A workflow with an active run is SKIPPED (not
      // reset) rather than failing the whole call — this is deliberately best-effort
      // across all workflows, not all-or-nothing. Registered BEFORE the :name-based
      // reset-output route below since this path has no :name segment.
      // Mutating — behind the same loopback/token guard as all other POST endpoints.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workflows' && parts[2] === 'reset-output-all' && parts.length === 3) {
        const results: Array<
          | { name: string; status: 'reset'; itemsDeleted: number; runsDeleted: number; wfRunsDeleted: number; filesRemoved: number; outDir: string | null }
          | { name: string; status: 'skipped'; reason: string }
        > = [];
        for (const wf of listWorkflows()) {
          if (workflowRunInProgress(wf.name)) {
            results.push({ name: wf.name, status: 'skipped', reason: 'active run in progress' });
            continue;
          }
          const outDir = await findWorkflowDataOut(wf.name);
          const result = resetWorkflowOutput(wf.name);
          const filesRemoved = outDir ? deleteDataOutContents(outDir) : 0;
          results.push({
            name: wf.name,
            status: 'reset',
            itemsDeleted: result.itemsDeleted,
            runsDeleted: result.runsDeleted,
            wfRunsDeleted: result.wfRunsDeleted,
            filesRemoved,
            outDir: outDir ? relativePath(JOBS_ROOT, outDir) : null,
          });
        }
        const resetCount = results.filter((r) => r.status === 'reset').length;
        const skipped = results.filter((r) => r.status === 'skipped') as Array<{ name: string; status: 'skipped'; reason: string }>;
        console.log(
          `[api] reset-output-all: ${resetCount} reset, ${skipped.length} skipped` +
            (skipped.length ? ` (${skipped.map((s) => `${s.name}: ${s.reason}`).join('; ')})` : ''),
        );
        return json(res, 200, {
          ok: true,
          totalWorkflows: results.length,
          resetCount,
          skippedCount: skipped.length,
          results,
        });
      }

      // POST /api/workflows/:name/reset-output
      // Clear all OUTPUT data for the named workflow: work_items ledger + work_item_runs
      // attribution + member job runs/logs + workflow_runs/logs + data/out/** files.
      // Preserves: data/raw/** (input data), chrome-profile, .env, definition tables
      // (jobs/workflows/services), and user settings (enabled/schedule/concurrency
      // overrides, service limits). Does NOT clear service_usage (cross-workflow meter).
      // Refuses to run while the workflow has an active run (avoids racing the executor).
      // Mutating — behind the same loopback/token guard as all other POST endpoints.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workflows' && parts[3] === 'reset-output') {
        const name = parts[2];
        if (!getWorkflow(name)) return json(res, 404, { error: 'workflow not found' });
        if (workflowRunInProgress(name)) {
          return json(res, 409, { error: `workflow "${name}" has an active run — wait for it to finish before resetting` });
        }
        // Find the workflow's data/out directory before clearing the DB (the directory
        // lookup uses cached module imports, so it's cheap and doesn't affect the DB).
        const outDir = await findWorkflowDataOut(name);
        // Perform the DB reset in a single transaction.
        const result = resetWorkflowOutput(name);
        // Delete filesystem artifacts (data/out/**) if the directory was found.
        const filesRemoved = outDir ? deleteDataOutContents(outDir) : 0;
        console.log(`[api] reset-output "${name}": ${result.itemsDeleted} items, ${result.runsDeleted} runs, ${result.wfRunsDeleted} wf-runs, ${filesRemoved} fs entries`);
        return json(res, 200, {
          ok: true,
          jobNames: result.jobNames,
          itemsDeleted: result.itemsDeleted,
          runsDeleted: result.runsDeleted,
          wfRunsDeleted: result.wfRunsDeleted,
          filesRemoved,
          outDir: outDir ? relativePath(JOBS_ROOT, outDir) : null,
        });
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
        let dependencies: Map<string, string[]> = new Map();
        try {
          const dag = buildDag(refs);
          firstWave = dag.waves[0] ?? [];
          lastWave = dag.waves[dag.waves.length - 1] ?? [];
          dependencies = dag.dependencies;
          // If the workflow is a single stage, first == last — show it as both input and output.
        } catch {
          return json(res, 200, {
            io: [],
            firstWave: [],
            lastWave: [],
            scoped: false,
            emptyReason: null,
            note: 'workflow DAG could not be parsed',
            selectedJob: null,
            scopedProducerJobs: [],
            scopedConsumerJobs: [],
          });
        }
        const jobParam = url.searchParams.get('job');
        let producerJobs = firstWave;
        let consumerJobs = lastWave;
        if (jobParam != null) {
          if (!refs.some((r) => r.job === jobParam)) {
            return json(res, 400, { error: `unknown job "${jobParam}" for this workflow` });
          }
          const predecessors = dependencies.get(jobParam) ?? [];
          if (predecessors.length === 0) {
            producerJobs = [jobParam];
            consumerJobs = [jobParam];
          } else {
            producerJobs = predecessors;
            consumerJobs = [jobParam];
          }
        }
        const { rows, scoped } = workItemIoRows(producerJobs, consumerJobs, run.id);
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
          selectedJob: jobParam ?? null,
          scopedProducerJobs: jobParam != null ? producerJobs : [],
          scopedConsumerJobs: jobParam != null ? consumerJobs : [],
        });
      }

      // GET /api/workflow-runs/:id/stage-io?job=<job>
      // Decoupled inputs/outputs for ONE stage of a run — an alternative to /io's
      // joined-by-root_key table (added for stock-digest's workflow-run page, which
      // has a genuine many-to-one aggregation stage that a single joined row can't
      // represent honestly). Returns the stage's own work_items rows this run as
      // `outputs` and its direct predecessor(s)' rows this run as `inputs`, with NO
      // attempt to pair them 1:1 — a real 9-row fan-out stays 9 rows. DB reads only.
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workflow-runs' && parts[3] === 'stage-io' && parts.length === 4) {
        const run = getWorkflowRun(parts[2]);
        if (!run) return json(res, 404, { error: 'workflow run not found' });
        const refs = getWorkflowJobs(run.workflow_name).map((m) => ({ job: m.job_name, dependsOn: m.depends_on }));
        // `overall=true` takes precedence over `job` when both are present (T384).
        if (url.searchParams.get('overall') === 'true') {
          if (refs.length === 0) {
            return json(res, 200, { inputs: [], outputs: [], predecessorJobs: [], outputJobs: [], job: '__overall__' });
          }
          let rootWave: string[] = [];
          let lastWave: string[] = [];
          try {
            const dag = buildDag(refs);
            rootWave = dag.waves[0] ?? [];
            lastWave = dag.waves[dag.waves.length - 1] ?? [];
          } catch {
            return json(res, 200, { inputs: [], outputs: [], predecessorJobs: [], outputJobs: [], job: '__overall__' });
          }
          const def = getWorkflowDefinition(run.workflow_name);
          const outputJobs =
            def?.outputJob && refs.some((r) => r.job === def.outputJob) ? [def.outputJob] : lastWave;
          const { inputs, outputs } = stageIoLists(outputJobs, rootWave, run.id);
          return json(res, 200, { inputs, outputs, predecessorJobs: rootWave, outputJobs, job: '__overall__' });
        }
        const jobParam = url.searchParams.get('job');
        if (!jobParam) return json(res, 400, { error: 'job query param is required' });
        if (!refs.some((r) => r.job === jobParam)) {
          return json(res, 400, { error: `unknown job "${jobParam}" for this workflow` });
        }
        let predecessors: string[] = [];
        try {
          predecessors = buildDag(refs).dependencies.get(jobParam) ?? [];
        } catch {
          return json(res, 200, { inputs: [], outputs: [], predecessorJobs: [], job: jobParam });
        }
        const { inputs, outputs } = stageIoLists([jobParam], predecessors, run.id);
        return json(res, 200, { inputs, outputs, predecessorJobs: predecessors, job: jobParam });
      }

      // GET /api/workflow-runs/:id/output?job=<job>&key=<key>  (T110)
      // Read-only: return the artifact a job produced for one work item, for the
      // workflow-run IO panel's output preview + full popover. Dispatches on the
      // item's declared output form (detail.format — see CLAUDE.md Output-form
      // convention). The `markdown` form (or unset) is confined via safeOutputMarkdown
      // to a `.md` file in data/out/; any other declared form uses safeOutputFile
      // (same guards, no .md restriction). Both are a pure local file read (no
      // paid/remote calls). "No artifact" is a benign 200 { found: false }.
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workflow-runs' && parts[3] === 'output' && parts.length === 4) {
        const run = getWorkflowRun(parts[2]);
        if (!run) return json(res, 404, { error: 'workflow run not found' });
        const jobName = url.searchParams.get('job');
        const key = url.searchParams.get('key');
        if (!jobName || !key) return json(res, 400, { error: 'job and key query params are required' });
        const { format, path: candidatePath } = resolveOutputForm(jobName, key);
        const safe = format === 'markdown' ? safeOutputMarkdown(candidatePath) : safeOutputFile(candidatePath);
        if (!safe) return json(res, 200, { found: false, job: jobName, key, format });
        let content: string;
        try {
          content = readFileSync(safe, 'utf8');
        } catch {
          return json(res, 200, { found: false, job: jobName, key, format });
        }
        const MAX = 512 * 1024; // cap the payload; this is a safety belt
        const truncated = content.length > MAX;
        return json(res, 200, {
          found: true,
          job: jobName,
          key,
          format,
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

      // GET /api/backlog — the harness TASKS.json backlog (read-only). Each task's
      // human-review flag `reviewed` is OVERLAID from the owner-owned reviews store
      // (.harness/tracking/reviews.json, T136) and human-done store (.harness/tracking/human-done.json,
      // T208). A human-done task shows done=true and reviewed=true (done implies reviewed).
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'backlog' && parts.length === 2) {
        return json(res, 200, readBacklog(backlogPath, reviewsPath, humanDonePath, manualFailPath, harnessDir));
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

      // POST /api/backlog/:id/done — mark a needs-human task done in the owner-owned
      // human-done store (.harness/tracking/human-done.json, T208). Only applies to tasks with
      // gate === 'needs-human'. Marking done implies reviewed. Serialized via the same
      // in-process mutex as reviewed POSTs; committed+pushed under the repo lock.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'backlog' && parts[3] === 'done' && parts.length === 4) {
        const id = decodeURIComponent(parts[2]);
        if (!/^T\d+$/.test(id)) return json(res, 400, { error: 'invalid task id' });
        // Validate: only needs-human tasks may be marked done via this endpoint.
        const backlog = readBacklog(backlogPath, reviewsPath, humanDonePath, manualFailPath, harnessDir);
        const task = (backlog.tasks as Array<{ id?: string; gate?: string | null }>).find((t) => t.id === id);
        if (!task) return json(res, 400, { error: `task ${id} not found in backlog` });
        if (task.gate !== 'needs-human') return json(res, 400, { error: `task ${id} is not a needs-human task` });
        const result = await serializeReview(async () => {
          writeHumanDoneEntry(humanDonePath, id, new Date().toISOString());
          return commitHumanDone(humanDonePath, id);
        });
        return json(res, 200, {
          ok: true,
          id,
          done: true,
          committed: result.committed,
          pushed: result.pushed,
          ...(result.warning ? { warning: result.warning } : {}),
        });
      }

      // POST /api/backlog/:id/failed  { failed?: boolean, reason?: string } — the owner's
      // "this DONE task actually failed" correction (manual-fail-signal). Writes the
      // owner-owned manual-fail.json overlay and commits+pushes under the repo lock. The
      // loop reads it to re-count the task as a failure for tier tuning + drop it from its
      // cell's audited-success count (so that category is built stronger + audited more).
      // `failed` defaults to true; `{ failed: false }` UNDOES a prior mark. A mark (not undo)
      // requires the task to be status 'done' (you're overturning a recorded success) and a
      // non-empty reason. Marking failed implies reviewed. Does NOT change task status.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'backlog' && parts[3] === 'failed' && parts.length === 4) {
        const id = decodeURIComponent(parts[2]);
        if (!/^T\d+$/.test(id)) return json(res, 400, { error: 'invalid task id' });
        const body = await readBody(req);
        const failed = body.failed === undefined ? true : body.failed === true;
        const reason = typeof body.reason === 'string' ? body.reason : '';
        if (failed) {
          const backlog = readBacklog(backlogPath, reviewsPath, humanDonePath, manualFailPath, harnessDir);
          const task = (backlog.tasks as Array<{ id?: string; status?: string }>).find((t) => t.id === id);
          if (!task) return json(res, 400, { error: `task ${id} not found in backlog` });
          if (task.status !== 'done') return json(res, 400, { error: `task ${id} is '${task.status}', not 'done' — manual-fail overturns a recorded success` });
          if (!reason.trim()) return json(res, 400, { error: 'reason (a non-empty string) is required when marking failed' });
        }
        const result = await serializeReview(async () => {
          writeManualFailEntry(manualFailPath, id, failed, reason, new Date().toISOString());
          return commitManualFail(manualFailPath, id, failed);
        });
        return json(res, 200, {
          ok: true,
          id,
          failed,
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
