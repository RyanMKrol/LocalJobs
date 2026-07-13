import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, isAbsolute, join as joinPath, relative as relativePath, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { type Gate, buildDag, classifyGates, deriveGates, shapesIdentical } from '../core/dag.js';
import type { GateResult } from '../core/types.js';
import { runWorkflow, cancelWorkflowRun, workflowRunInProgress, effectiveWorkflowConcurrency, DEFAULT_WORKFLOW_CONCURRENCY, effectiveWorkflowNotifyEnabled } from '../core/workflow-executor.js';
import { nextWorkflowRun, rescheduleWorkflow } from '../core/scheduler.js';
import { Cron } from 'croner';
import { getJobDefinition, getWorkflowDefinition } from '../workflows/registry.js';
import { moviesConfig } from '../workflows/movies/config.js';
import { NOTIFY_JOB as MOVIE_GAPS_JOB, gapKey } from '../workflows/movies/stages/notify.js';
import { RECS_JOB, recKey } from '../workflows/movies/recs.js';
import type { FranchiseGapsFile, RecommendationsFile } from '../workflows/movies/types.js';
import { tvRecsConfig } from '../workflows/tv-recs/config.js';
import { RECS_JOB as TV_RECS_JOB, recKey as tvRecKey } from '../workflows/tv-recs/recs.js';
import type { RecommendationsFile as TvRecommendationsFile } from '../workflows/tv-recs/types.js';
import { plexConfig } from '../workflows/missing-tv-seasons/config.js';
import { NOTIFY_JOB as PLEX_SEASONS_JOB, pairKey } from '../workflows/missing-tv-seasons/stages/notify.js';
import type { MissingSeasonsFile } from '../workflows/missing-tv-seasons/types.js';
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
  serviceCacheCounts,
  clearServiceCache,
  stageIoLists,
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
  setWorkflowCertified,
  stuckCount,
  stuckItems,
  unstickWorkItem,
  ignoreWorkItem,
  ignoreSurfacedItem,
  ignoreSurfacedItems,
  unignoreSurfacedItem,
  unignoreSurfacedItems,
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

// The workflows tree (src/workflows), resolved relative to this file. Job output artifacts
// (e.g. the markdown profiles the places/perfumes final stages write) live in
// each job's own `data/out/` folder under here. The output endpoint confines its
// reads to this tree so a recorded path can never escape it. `realpathSync` so
// the prefix check survives platform symlinks (e.g. macOS /var → /private/var).
const WORKFLOWS_ROOT = realpathSync(fileURLToPath(new URL('../workflows', import.meta.url)));

/** Whether `child` is the same as, or nested under, `parent` (path-prefix safe). */
export function isWithin(parent: string, child: string): boolean {
  const rel = relativePath(parent, child);
  // Inside iff the relative path doesn't climb out (`..`) and isn't absolute.
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}

/**
 * Scan WORKFLOWS_ROOT for `*.workflow.ts` / `*.workflow.js` files, import each one
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
        if (entry.isDirectory()) {
          if (entry.name === 'data') continue; // never scan generated/data trees for code
          out.push(...walkForWfFiles(joinPath(dir, entry.name)));
        } else if (isWfFile(entry.name)) out.push(joinPath(dir, entry.name));
      }
    } catch { /* skip unreadable dirs */ }
    return out;
  }
  for (const file of walkForWfFiles(WORKFLOWS_ROOT)) {
    try {
      const mod = await import(pathToFileURL(file).href) as { default?: { name?: string } };
      if (mod.default?.name === workflowName) {
        const candidate = joinPath(dirname(file), 'data', 'out');
        // Validate the candidate is within WORKFLOWS_ROOT (it always should be, but be explicit).
        if (!isWithin(WORKFLOWS_ROOT, resolvePath(candidate))) continue;
        if (existsSync(candidate)) return candidate;
      }
    } catch { /* skip import errors */ }
  }
  return null;
}

/**
 * Delete all children of `outDir` without removing the directory itself.
 * Validates that `outDir` is within WORKFLOWS_ROOT and contains `data/out` in its
 * path before touching anything. Returns the number of top-level entries removed.
 * Safe to call when the directory doesn't exist (returns 0). Exported for testing.
 */
export function deleteDataOutContents(outDir: string): number {
  if (!isWithin(WORKFLOWS_ROOT, resolvePath(outDir))) return 0; // safety: must stay within workflows tree
  if (!(outDir.endsWith(`${sep}data${sep}out`) || outDir.includes(`${sep}data${sep}out${sep}`))) return 0;   // safety: must be a genuine data/out dir
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
 *  - must stay under {@link WORKFLOWS_ROOT},
 *  - must live inside a job-local `data/out/` directory,
 *  - must be a regular `.md` file that exists.
 * No network/paid calls — a local file stat + realpath only.
 */
export function safeOutputMarkdown(candidate: string | null): string | null {
  if (!candidate) return null;
  // T447: a relative candidate (the current storage convention) is joined against
  // the freshly-computed WORKFLOWS_ROOT, not process.cwd() — an absolute (legacy,
  // pre-fix) candidate resolves exactly as before.
  const abs = isAbsolute(candidate) ? resolvePath(candidate) : resolvePath(WORKFLOWS_ROOT, candidate);
  if (!abs.toLowerCase().endsWith('.md')) return null;
  let real: string;
  try {
    real = realpathSync(abs); // follows symlinks; throws if the file is missing
  } catch {
    return null;
  }
  if (!isWithin(WORKFLOWS_ROOT, real)) return null; // escaped the workflows tree
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
 *  - must stay under {@link WORKFLOWS_ROOT},
 *  - must live inside a job-local `data/out/` directory,
 *  - must be a regular file that exists.
 * No network/paid calls — a local file stat + realpath only.
 *
 * Use this for declared non-markdown output forms (see Output-form convention in
 * CLAUDE.md). For the `markdown` form continue using {@link safeOutputMarkdown}.
 */
export function safeOutputFile(candidate: string | null): string | null {
  if (!candidate) return null;
  // T447: see safeOutputMarkdown — relative candidates resolve against WORKFLOWS_ROOT.
  const abs = isAbsolute(candidate) ? resolvePath(candidate) : resolvePath(WORKFLOWS_ROOT, candidate);
  let real: string;
  try {
    real = realpathSync(abs); // follows symlinks; throws if the file is missing
  } catch {
    return null;
  }
  if (!isWithin(WORKFLOWS_ROOT, real)) return null; // escaped the workflows tree
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
 * A single route entry: an HTTP method + a `/`-separated path pattern (a
 * `:name`-style segment matches any literal segment and is captured into
 * `ctx.params[name]`) + the handler that serves it.
 */
type Route = {
  method: string;
  pattern: string;
  handler: (ctx: RouteCtx) => Promise<void> | void;
};

/** Per-request context passed to a route handler. */
type RouteCtx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The full request path split on `/` with empty segments removed, e.g. `['api','jobs','demo','runs']`. */
  parts: string[];
  /** Named params captured from `:segment` pattern pieces (e.g. `{ name: 'demo' }`). */
  params: Record<string, string>;
};

/**
 * Match `method` + `pathParts` against `routes` and return the first route whose
 * pattern matches, plus its captured params — or `null` if nothing matches.
 *
 * A match requires the pattern and the path to have the EXACT SAME segment
 * count — this is the fix for the loose-match bug class the old positional
 * `parts[n] === '...'` dispatch had (e.g. `GET /api/workflows/:name/runs` used
 * to match ANY path with `parts[3] === 'runs'` regardless of how many segments
 * followed, so `GET /api/workflows/foo/runs/extra` incorrectly matched too). A
 * `:segment` in the pattern matches any single literal path segment and is
 * captured by name; every other segment must match literally. Route order is
 * otherwise irrelevant — no two routes for the same method + segment count ever
 * overlap in this router, since a differing literal segment or method rules it out.
 */
export function matchRoute(
  method: string,
  pathParts: readonly string[],
  routes: readonly Route[],
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const patternParts = route.pattern.split('/').filter(Boolean);
    if (patternParts.length !== pathParts.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < patternParts.length; i++) {
      const seg = patternParts[i];
      if (seg.startsWith(':')) {
        params[seg.slice(1)] = pathParts[i];
      } else if (seg !== pathParts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

/**
 * Validate a bulk audit-family request body containing season pairs (T531).
 * Ensures `items` is an array of { tmdbId, season } objects with positive integers.
 * Returns the validated items or null if validation fails.
 */
function validateSeasonPairs(items: unknown): { tmdbId: number; season: number }[] | null {
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
    return null;
  }
  return items as { tmdbId: number; season: number }[];
}

/**
 * Audit endpoint families (movie-gaps, movie-recs, tv-recs, missing-seasons) configuration (T531).
 * Each family exposes four verbs: ignore, unignore, ignore-bulk, unignore-bulk.
 */
interface AuditFamily {
  base: string; // e.g. 'movie-gaps'
  job: string; // job name
  keyFromParams: (params: Record<string, string>) => string; // closure to build the ledger key
}

const AUDIT_FAMILIES: AuditFamily[] = [
  {
    base: 'movie-gaps',
    job: MOVIE_GAPS_JOB,
    keyFromParams: (p) => gapKey(Number(p.tmdbId)),
  },
  {
    base: 'movie-recs',
    job: RECS_JOB,
    keyFromParams: (p) => recKey(Number(p.tmdbId)),
  },
  {
    base: 'tv-recs',
    job: TV_RECS_JOB,
    keyFromParams: (p) => tvRecKey(Number(p.tmdbId)),
  },
  {
    base: 'missing-seasons',
    job: PLEX_SEASONS_JOB,
    keyFromParams: (p) => pairKey(Number(p.tmdbId), Number(p.season)),
  },
];

const routes: Route[] = [
  // GET /api/health
  {
    method: 'GET',
    pattern: '/api/health',
    handler: ({ res }) => {
      return json(res, 200, { ok: true, time: new Date().toISOString() });
    },
  },

  // GET /api/runs?limit=
  {
    method: 'GET',
    pattern: '/api/runs',
    handler: ({ res, url }) => {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return json(res, 200, { runs: listRecentRuns(limit) });
    },
  },

  // GET /api/runs/:id  (+ ?after= for incremental logs)
  {
    method: 'GET',
    pattern: '/api/runs/:id',
    handler: ({ res, url, params }) => {
      const run = getRun(params.id);
      if (!run) return json(res, 404, { error: 'run not found' });
      const after = Number(url.searchParams.get('after') ?? 0);
      return json(res, 200, { run, logs: getLogs(params.id, after) });
    },
  },

  // GET /api/logs  — global cross-cutting log feed (job + workflow logs merged, newest first)
  // ?level=info,warn,error  ?job=<name>  ?workflow=<name>  ?q=<substring>  ?windowHours=  ?before=<cursor>  ?limit=
  {
    method: 'GET',
    pattern: '/api/logs',
    handler: ({ res, url }) => {
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
    },
  },

  // GET /api/stuck  (optionally ?job=<name> or ?workflow=<name>) — items that gave up, won't retry
  {
    method: 'GET',
    pattern: '/api/stuck',
    handler: ({ res, url }) => {
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
    },
  },

  // POST /api/stuck/unstick  { job, key } — reset a stuck item so it retries
  {
    method: 'POST',
    pattern: '/api/stuck/unstick',
    handler: async ({ res, req }) => {
      const body = await readBody(req);
      if (!body.job || !body.key) return json(res, 400, { error: 'job and key are required' });
      const unstuck = unstickWorkItem(String(body.job), String(body.key));
      return json(res, 200, { ok: true, unstuck });
    },
  },

  // POST /api/stuck/ignore  { job, key } — permanently park a stuck item
  // (manual only; never retries, drops off the stuck list, shows on the
  // overview's Ignored tile)
  {
    method: 'POST',
    pattern: '/api/stuck/ignore',
    handler: async ({ res, req }) => {
      const body = await readBody(req);
      if (!body.job || !body.key) return json(res, 400, { error: 'job and key are required' });
      const ignored = ignoreWorkItem(String(body.job), String(body.key));
      return json(res, 200, { ok: true, ignored });
    },
  },

  // POST /api/stuck/unstick-bulk  { scope?: 'all'|{job}|{workflow} }
  // Bulk-unstick: delete all currently-failed rows in scope so they retry fresh.
  // scope omitted / 'all' → every stuck item; { job } → one job; { workflow } → its members.
  {
    method: 'POST',
    pattern: '/api/stuck/unstick-bulk',
    handler: async ({ res, req }) => {
      const body = await readBody(req);
      const scope = resolveBulkScope(body);
      if (scope === null) return json(res, 400, { error: 'invalid scope: workflow must be a known workflow name' });
      const unstuck = bulkUnstickItems(scope);
      return json(res, 200, { ok: true, unstuck });
    },
  },

  // POST /api/stuck/ignore-bulk  { scope?: 'all'|{job}|{workflow} }
  // Bulk-ignore: permanently mark all currently-failed rows in scope as 'ignored'.
  {
    method: 'POST',
    pattern: '/api/stuck/ignore-bulk',
    handler: async ({ res, req }) => {
      const body = await readBody(req);
      const scope = resolveBulkScope(body);
      if (scope === null) return json(res, 400, { error: 'invalid scope: workflow must be a known workflow name' });
      const ignored = bulkIgnoreItems(scope);
      return json(res, 200, { ok: true, ignored });
    },
  },

  // GET /api/ignored  (optionally ?job=<name>) — manually-parked items
  // (overview-only; never counted as stuck)
  {
    method: 'GET',
    pattern: '/api/ignored',
    handler: ({ res, url }) => {
      const jobFilter = url.searchParams.get('job');
      const items = ignoredItems().filter((i) => !jobFilter || i.job_name === jobFilter);
      return json(res, 200, { ignored: items });
    },
  },

  // ── Audit endpoint families (movie-gaps, movie-recs, tv-recs, missing-seasons) ──
  // All four audit families expose identical verb sets (ignore, unignore, ignore-bulk,
  // unignore-bulk). GET endpoints and single-item endpoints are per-family; bulk verbs
  // are registered from the shared AUDIT_FAMILIES config loop below.

  // GET /api/movie-gaps, GET /api/movie-recs, GET /api/tv-recs, GET /api/missing-seasons
  // and their per-item :id/ignore and :id/unignore endpoints:
  {
    method: 'GET',
    pattern: '/api/movie-gaps',
    handler: ({ res }) => {
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
    },
  },

  {
    method: 'POST',
    pattern: '/api/movie-gaps/:tmdbId/ignore',
    handler: ({ res, params }) => {
      const tmdbId = Number(params.tmdbId);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
        return json(res, 400, { error: 'tmdbId must be a positive integer' });
      }
      const ignored = ignoreSurfacedItem(MOVIE_GAPS_JOB, gapKey(tmdbId));
      return json(res, 200, { ok: true, ignored });
    },
  },

  {
    method: 'POST',
    pattern: '/api/movie-gaps/:tmdbId/unignore',
    handler: ({ res, params }) => {
      const tmdbId = Number(params.tmdbId);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
        return json(res, 400, { error: 'tmdbId must be a positive integer' });
      }
      const unignored = unignoreSurfacedItem(MOVIE_GAPS_JOB, gapKey(tmdbId));
      return json(res, 200, { ok: true, unignored });
    },
  },

  {
    method: 'GET',
    pattern: '/api/movie-recs',
    handler: ({ res }) => {
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
    },
  },

  {
    method: 'POST',
    pattern: '/api/movie-recs/:tmdbId/ignore',
    handler: ({ res, params }) => {
      const tmdbId = Number(params.tmdbId);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
        return json(res, 400, { error: 'tmdbId must be a positive integer' });
      }
      let detail: { title: string; year: number | null } | undefined;
      try {
        const file = JSON.parse(readFileSync(moviesConfig.recsOut, 'utf8')) as RecommendationsFile;
        const rec = (file.recommendations ?? []).find((r) => r.tmdbId === tmdbId);
        if (rec) detail = { title: rec.title, year: rec.year };
      } catch {
        // recommendations.json not readable — ignore with no recoverable title.
      }
      const ignored = ignoreSurfacedItem(RECS_JOB, recKey(tmdbId), detail);
      return json(res, 200, { ok: true, ignored });
    },
  },

  {
    method: 'POST',
    pattern: '/api/movie-recs/:tmdbId/unignore',
    handler: ({ res, params }) => {
      const tmdbId = Number(params.tmdbId);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
        return json(res, 400, { error: 'tmdbId must be a positive integer' });
      }
      const unignored = unignoreSurfacedItem(RECS_JOB, recKey(tmdbId));
      return json(res, 200, { ok: true, unignored });
    },
  },

  {
    method: 'GET',
    pattern: '/api/tv-recs',
    handler: ({ res }) => {
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
    },
  },

  {
    method: 'POST',
    pattern: '/api/tv-recs/:tmdbId/ignore',
    handler: ({ res, params }) => {
      const tmdbId = Number(params.tmdbId);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
        return json(res, 400, { error: 'tmdbId must be a positive integer' });
      }
      let detail: { title: string; year: number | null } | undefined;
      try {
        const file = JSON.parse(readFileSync(tvRecsConfig.recsOut, 'utf8')) as TvRecommendationsFile;
        const rec = (file.recommendations ?? []).find((r) => r.tmdbId === tmdbId);
        if (rec) detail = { title: rec.title, year: rec.year };
      } catch {
        // recommendations.json not readable — ignore with no recoverable title.
      }
      const ignored = ignoreSurfacedItem(TV_RECS_JOB, tvRecKey(tmdbId), detail);
      return json(res, 200, { ok: true, ignored });
    },
  },

  {
    method: 'POST',
    pattern: '/api/tv-recs/:tmdbId/unignore',
    handler: ({ res, params }) => {
      const tmdbId = Number(params.tmdbId);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
        return json(res, 400, { error: 'tmdbId must be a positive integer' });
      }
      const unignored = unignoreSurfacedItem(TV_RECS_JOB, tvRecKey(tmdbId));
      return json(res, 200, { ok: true, unignored });
    },
  },

  {
    method: 'GET',
    pattern: '/api/missing-seasons',
    handler: ({ res }) => {
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
    },
  },

  {
    method: 'POST',
    pattern: '/api/missing-seasons/:tmdbId/:season/ignore',
    handler: ({ res, params }) => {
      const tmdbId = Number(params.tmdbId);
      const season = Number(params.season);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !Number.isInteger(season) || season <= 0) {
        return json(res, 400, { error: 'tmdbId and season must be positive integers' });
      }
      const ignored = ignoreSurfacedItem(PLEX_SEASONS_JOB, pairKey(tmdbId, season));
      return json(res, 200, { ok: true, ignored });
    },
  },

  {
    method: 'POST',
    pattern: '/api/missing-seasons/:tmdbId/:season/unignore',
    handler: ({ res, params }) => {
      const tmdbId = Number(params.tmdbId);
      const season = Number(params.season);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !Number.isInteger(season) || season <= 0) {
        return json(res, 400, { error: 'tmdbId and season must be positive integers' });
      }
      const unignored = unignoreSurfacedItem(PLEX_SEASONS_JOB, pairKey(tmdbId, season));
      return json(res, 200, { ok: true, unignored });
    },
  },

  // ── Bulk audit endpoints (T531) — ignore/unignore in bulk for all four families ──
  // POST /api/movie-gaps/ignore-bulk, POST /api/movie-gaps/unignore-bulk,
  // POST /api/movie-recs/ignore-bulk, POST /api/movie-recs/unignore-bulk,
  // POST /api/tv-recs/ignore-bulk, POST /api/tv-recs/unignore-bulk,
  // POST /api/missing-seasons/ignore-bulk, POST /api/missing-seasons/unignore-bulk
  ...AUDIT_FAMILIES.flatMap((family) => [
    {
      method: 'POST',
      pattern: `/api/${family.base}/ignore-bulk`,
      handler: async (ctx: RouteCtx) => {
        const body: { tmdbIds?: unknown; items?: unknown } = await readBody(ctx.req).catch(() => ({}));
        let keys: string[];
        if (family.base === 'missing-seasons') {
          const items = validateSeasonPairs(body.items);
          if (!items) {
            return json(ctx.res, 400, { error: 'items must be an array of { tmdbId, season } objects with positive integers' });
          }
          keys = items.map((it) => family.keyFromParams({ tmdbId: String(it.tmdbId), season: String(it.season) }));
        } else {
          const ids = body.tmdbIds;
          if (!Array.isArray(ids) || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
            return json(ctx.res, 400, { error: 'tmdbIds must be an array of positive integers' });
          }
          keys = (ids as number[]).map((id) => family.keyFromParams({ tmdbId: String(id) }));
        }
        const ignored = ignoreSurfacedItems(family.job, keys);
        return json(ctx.res, 200, { ok: true, ignored });
      },
    },
    {
      method: 'POST',
      pattern: `/api/${family.base}/unignore-bulk`,
      handler: async (ctx: RouteCtx) => {
        const body: { tmdbIds?: unknown; items?: unknown } = await readBody(ctx.req).catch(() => ({}));
        let keys: string[];
        if (family.base === 'missing-seasons') {
          const items = validateSeasonPairs(body.items);
          if (!items) {
            return json(ctx.res, 400, { error: 'items must be an array of { tmdbId, season } objects with positive integers' });
          }
          keys = items.map((it) => family.keyFromParams({ tmdbId: String(it.tmdbId), season: String(it.season) }));
        } else {
          const ids = body.tmdbIds;
          if (!Array.isArray(ids) || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
            return json(ctx.res, 400, { error: 'tmdbIds must be an array of positive integers' });
          }
          keys = (ids as number[]).map((id) => family.keyFromParams({ tmdbId: String(id) }));
        }
        const unignored = unignoreSurfacedItems(family.job, keys);
        return json(ctx.res, 200, { ok: true, unignored });
      },
    },
  ]),

  // GET /api/jobs  (each flagged with its workflow, if it's a member)
  {
    method: 'GET',
    pattern: '/api/jobs',
    handler: ({ res }) => {
      const memberOf = memberWorkflowMap();
      const rows = listJobs().map((j) => ({ ...j, ...jobView(j.name), workflow: memberOf.get(j.name) ?? null }));
      return json(res, 200, { jobs: rows });
    },
  },

  // GET /api/jobs/:name/runs
  {
    method: 'GET',
    pattern: '/api/jobs/:name/runs',
    handler: ({ res, params }) => {
      return json(res, 200, { runs: listRunsForJob(params.name) });
    },
  },

  // GET /api/jobs/:name
  {
    method: 'GET',
    pattern: '/api/jobs/:name',
    handler: ({ res, params }) => {
      const job = listJobs().find((j) => j.name === params.name);
      if (!job) return json(res, 404, { error: 'job not found' });
      return json(res, 200, { job: { ...job, ...jobView(job.name) } });
    },
  },

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
  {
    method: 'POST',
    pattern: '/api/jobs/:name/prune',
    handler: async ({ res, req, params }) => {
      const jobName = params.name;
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
    },
  },

  // POST /api/jobs/:name/timeout  { timeoutMs }
  // Persist a USER override of the job's `timeoutMs` (T297) — mirrors the
  // workflow schedule/maxConcurrency overrides, but scoped to a JOB row: unlike
  // schedule/enabled (workflow-only, T070), timeoutMs is a genuinely job-scoped
  // execution parameter. The executor already reads the DB row's value in
  // preference to the manifest constant, so no executor change is needed for
  // the override to take effect on the next run. Guarded by the same
  // loopback/token mutation check as /toggle, /run, /schedule, /concurrency.
  {
    method: 'POST',
    pattern: '/api/jobs/:name/timeout',
    handler: async ({ res, req, params }) => {
      const jobName = params.name;
      const body = await readBody(req);
      const timeoutMs = body.timeoutMs;
      if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 0) {
        return json(res, 400, { error: 'timeoutMs must be a non-negative integer (milliseconds)' });
      }
      const updated = updateJobTimeout(jobName, timeoutMs);
      if (!updated) return json(res, 404, { error: 'job not found' });
      return json(res, 200, { ok: true, job: updated });
    },
  },

  // NOTE: there is intentionally NO POST /api/jobs/:name/toggle (T070). The
  // enable toggle lives on the workflow (POST /api/workflows/:name/toggle) —
  // a job has no enabled flag of its own.

  // GET /api/workflows
  {
    method: 'GET',
    pattern: '/api/workflows',
    handler: ({ res }) => {
      const rows = listWorkflows().map((p) => {
        const wfDef = getWorkflowDefinition(p.name);
        const effective_notify_enabled = wfDef ? effectiveWorkflowNotifyEnabled(wfDef) : p.notify_enabled !== 0;
        return { ...p, effective_notify_enabled, ...workflowView(p.name) };
      });
      return json(res, 200, { workflows: rows });
    },
  },

  // GET /api/workflows/:name/runs
  {
    method: 'GET',
    pattern: '/api/workflows/:name/runs',
    handler: ({ res, params }) => {
      return json(res, 200, { runs: listWorkflowRunsForWorkflow(params.name) });
    },
  },

  // GET /api/workflows/:name
  {
    method: 'GET',
    pattern: '/api/workflows/:name',
    handler: ({ res, params }) => {
      const p = getWorkflow(params.name);
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
    },
  },

  // GET /api/workflows/:name/gates/:producer/:key
  // Run-AGNOSTIC, definition-level inspection of ONE validation gate for the
  // definition view's gate detail page: the structural gate (key, enriched
  // description, producer→consumer) plus each side's declared `shape` — the
  // EXPECTED side only. It does NOT run the contracts' `check()`, so there are
  // NO per-run actuals and NO file/paid/remote reads at all (purely the
  // statically-declared contract metadata) — safe to load freely. The
  // run-scoped GET /api/workflow-runs/:id/gates/... endpoint is the one that
  // layers a specific run's actual-vs-expected on top.
  {
    method: 'GET',
    pattern: '/api/workflows/:name/gates/:producer/:key',
    handler: ({ res, params }) => {
      const name = params.name;
      if (!getWorkflow(name)) return json(res, 404, { error: 'workflow not found' });
      const producer = decodeURIComponent(params.producer);
      const key = decodeURIComponent(params.key);
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
    },
  },

  // GET /api/workflows/:name/output-items  (T205)
  // Return the terminal-stage work items with status='success', de-duped by
  // (job_name, item_key). Powers the unified Output section on every workflow's
  // detail page — items are naturally de-duped because the ledger has a UNIQUE
  // key per (job_name, item_key). Read-only, DB only, no paid/remote calls.
  {
    method: 'GET',
    pattern: '/api/workflows/:name/output-items',
    handler: ({ res, params }) => {
      const name = params.name;
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
    },
  },

  // GET /api/workflows/:name/output?job=&key=  (T205)
  // Return the artifact for one workflow output item, not scoped to a specific run.
  // Dispatches on the item's declared output form (detail.format — see CLAUDE.md
  // Output-form convention). The `markdown` form (or unset) uses safeOutputMarkdown
  // (must end .md + inside data/out/). Any other declared form uses safeOutputFile
  // (same guards, no .md restriction). Both confine reads to data/out/ trees.
  {
    method: 'GET',
    pattern: '/api/workflows/:name/output',
    handler: ({ res, url }) => {
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
        file: relativePath(WORKFLOWS_ROOT, safe),
        bytes: Buffer.byteLength(content),
        truncated,
        content: truncated ? content.slice(0, MAX) : content,
      });
    },
  },

  // POST /api/workflows/:name/run   (optional body { limit })
  // A positive-integer `limit` caps the manual run to N originating inputs and
  // runs all their fan-out (T094); omit it for an unlimited run. A limit is
  // rejected for a workflow with no stage that declares input keys.
  {
    method: 'POST',
    pattern: '/api/workflows/:name/run',
    handler: async ({ res, req, params }) => {
      const def = getWorkflowDefinition(params.name);
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
    },
  },

  // POST /api/workflows/run-all   (optional body { limit }, default 3)
  // Fleet-wide "run everything" sweep: fires a manual run of EVERY workflow
  // (including disabled ones — enabled only gates the scheduler, and manual runs
  // already bypass it). A workflow already running is SKIPPED, not treated as an
  // error for the whole call — best-effort across all workflows, mirroring
  // reset-output-all. A workflow with no stage declaring input keys is run
  // UNLIMITED (per T094, `limit` is a no-op for it) rather than rejected. Each
  // workflow's run is fire-and-forget (same as the single-workflow /run endpoint
  // above) — this endpoint does not wait for any run to finish. This path has no
  // `:name` segment so it never collides with the pattern above (different
  // segment shape entirely — the matcher requires exact literal/param agreement).
  {
    method: 'POST',
    pattern: '/api/workflows/run-all',
    handler: async ({ res, req }) => {
      const body = await readBody(req);
      let limit = 3;
      if (body.limit !== undefined && body.limit !== null && body.limit !== '') {
        limit = Number(body.limit);
        if (!Number.isInteger(limit) || limit < 1) {
          return json(res, 400, { error: 'limit must be a positive integer' });
        }
      }
      const results: Array<
        | { name: string; status: 'started'; limited: boolean; limit: number | null }
        | { name: string; status: 'skipped'; reason: string }
      > = [];
      for (const wf of listWorkflows()) {
        const def = getWorkflowDefinition(wf.name);
        if (!def) continue;
        if (workflowRunInProgress(wf.name)) {
          results.push({ name: wf.name, status: 'skipped', reason: 'already running' });
          continue;
        }
        const limited = def.jobs.some((j) => getJobDefinition(j.job)?.inputKeys);
        runWorkflow(def, 'manual', limited ? { limit } : {}).catch((e) =>
          console.error('[api] run-all: workflow run error', wf.name, e),
        );
        results.push({ name: wf.name, status: 'started', limited, limit: limited ? limit : null });
      }
      const startedCount = results.filter((r) => r.status === 'started').length;
      const skipped = results.filter((r) => r.status === 'skipped') as Array<{ name: string; status: 'skipped'; reason: string }>;
      console.log(
        `[api] run-all: ${startedCount} started (limit ${limit}), ${skipped.length} skipped` +
          (skipped.length ? ` (already running: ${skipped.map((s) => s.name).join(', ')})` : ''),
      );
      return json(res, 202, {
        ok: true,
        totalWorkflows: results.length,
        startedCount,
        skippedCount: skipped.length,
        limit,
        results,
      });
    },
  },

  // POST /api/workflows/:name/toggle  { enabled }
  {
    method: 'POST',
    pattern: '/api/workflows/:name/toggle',
    handler: async ({ res, req, params }) => {
      const body = await readBody(req);
      setWorkflowEnabled(params.name, !!body.enabled);
      return json(res, 200, { ok: true, enabled: !!body.enabled });
    },
  },

  // POST /api/workflows/:name/schedule  { schedule }
  // Persist a USER override of the workflow's cron schedule (T135) and apply it
  // to the live scheduler WITHOUT a daemon restart — the user-owned schedule is
  // preserved across code-syncs (via `schedule_overridden`, like `enabled`). An
  // empty/blank value clears it to manual-only (null). A non-empty value MUST be
  // a valid croner pattern — validated by attempting `new Cron(expr, {paused})`
  // — else 400 (never crashing the daemon). Unknown workflow → 404. Mutating, so
  // it goes through the same loopback/token guard as /toggle, /run, /limits above.
  {
    method: 'POST',
    pattern: '/api/workflows/:name/schedule',
    handler: async ({ res, req, params }) => {
      const name = params.name;
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
    },
  },

  // POST /api/workflows/:name/concurrency  { maxConcurrency }
  // Persist a USER override of the workflow's bounded-parallelism cap (T169).
  // Mirrors the schedule override: user-owned + code-reconciled (via
  // `max_concurrency_overridden`, like `enabled`/`schedule`). `runWorkflow` reads
  // the effective value FRESH each run, so an edit takes effect on the NEXT run
  // with no daemon restart. The value MUST be a positive integer ≥ 1 — else 400,
  // before it reaches the store. Unknown workflow → 404. Mutating, so it goes
  // through the same loopback/token guard as /toggle, /run, /schedule, /limits.
  {
    method: 'POST',
    pattern: '/api/workflows/:name/concurrency',
    handler: async ({ res, req, params }) => {
      const name = params.name;
      if (!getWorkflow(name)) return json(res, 404, { error: 'workflow not found' });
      const body = await readBody(req);
      const n = Number(body.maxConcurrency);
      if (!Number.isInteger(n) || (n !== 0 && n < 1)) {
        return json(res, 400, { error: 'maxConcurrency must be a positive integer ≥ 1, or 0 for unlimited' });
      }
      updateWorkflowConcurrency(name, n);
      return json(res, 200, { ok: true, max_concurrency: n });
    },
  },

  // POST /api/workflows/:name/notify  { notifyEnabled }
  // Persist a USER override of whether the workflow sends the run-end aggregate
  // push notification (T285). Mirrors the concurrency override: user-owned +
  // code-reconciled (via `notify_enabled_overridden`, like `enabled`/`schedule`/
  // `max_concurrency`). `runWorkflow` reads the effective value FRESH each run, so
  // a toggle takes effect on the NEXT run with no daemon restart. The body MUST be
  // a boolean — else 400. Unknown workflow → 404. Mutating, so it goes through the
  // same loopback/token guard as /toggle, /run, /schedule, /concurrency, /limits.
  {
    method: 'POST',
    pattern: '/api/workflows/:name/notify',
    handler: async ({ res, req, params }) => {
      const name = params.name;
      if (!getWorkflow(name)) return json(res, 404, { error: 'workflow not found' });
      const body = await readBody(req);
      if (typeof body.notifyEnabled !== 'boolean') {
        return json(res, 400, { error: 'notifyEnabled must be a boolean' });
      }
      updateWorkflowNotifyEnabled(name, body.notifyEnabled);
      return json(res, 200, { ok: true, notify_enabled: body.notifyEnabled });
    },
  },

  // POST /api/workflows/:name/certify  { certified }
  // Persist a plain USER-set "reviewed & settled" flag on the workflow (T497) —
  // distinct from the harness's own per-task reviewed/done overlays. Unlike the
  // overrides above, this has no code/manifest source, so there is no
  // `_overridden` reconcile — it's a toggle-only, purely informational flag with
  // no functional/scheduling/notification side effects. The body MUST be a
  // boolean — else 400. Unknown workflow → 404. Mutating, so it goes through the
  // same loopback/token guard as /toggle, /run, /schedule, /concurrency, /notify.
  {
    method: 'POST',
    pattern: '/api/workflows/:name/certify',
    handler: async ({ res, req, params }) => {
      const name = params.name;
      if (!getWorkflow(name)) return json(res, 404, { error: 'workflow not found' });
      const body = await readBody(req);
      if (typeof body.certified !== 'boolean') {
        return json(res, 400, { error: 'certified must be a boolean' });
      }
      setWorkflowCertified(name, body.certified);
      return json(res, 200, { ok: true, certified: body.certified });
    },
  },

  // POST /api/workflows/reset-output-all
  // Bulk variant of reset-output (T322): runs the SAME per-workflow reset across
  // EVERY workflow in one call. A workflow with an active run is SKIPPED (not
  // reset) rather than failing the whole call — this is deliberately best-effort
  // across all workflows, not all-or-nothing. This path has no `:name` segment so
  // it never collides with the :name-based reset-output route below.
  // Mutating — behind the same loopback/token guard as all other POST endpoints.
  {
    method: 'POST',
    pattern: '/api/workflows/reset-output-all',
    handler: async ({ res }) => {
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
          outDir: outDir ? relativePath(WORKFLOWS_ROOT, outDir) : null,
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
    },
  },

  // POST /api/workflows/:name/reset-output
  // Clear all OUTPUT data for the named workflow: work_items ledger + work_item_runs
  // attribution + member job runs/logs + workflow_runs/logs + data/out/** files.
  // Preserves: data/raw/** (input data), chrome-profile, .env, definition tables
  // (jobs/workflows/services), and user settings (enabled/schedule/concurrency
  // overrides, service limits). Does NOT clear service_usage (cross-workflow meter).
  // Refuses to run while the workflow has an active run (avoids racing the executor).
  // Mutating — behind the same loopback/token guard as all other POST endpoints.
  {
    method: 'POST',
    pattern: '/api/workflows/:name/reset-output',
    handler: async ({ res, params }) => {
      const name = params.name;
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
        outDir: outDir ? relativePath(WORKFLOWS_ROOT, outDir) : null,
      });
    },
  },

  // GET /api/cache
  // Read-only: per-service row counts in the service_cache table (T451).
  {
    method: 'GET',
    pattern: '/api/cache',
    handler: ({ res }) => {
      return json(res, 200, { counts: serviceCacheCounts() });
    },
  },

  // POST /api/cache/clear
  // Deletes rows from service_cache — all rows, or just one service when a
  // { serviceName } body is given. Distinct from /api/workflows/reset-output(-all),
  // which never touches service_cache. Mutating — behind the same loopback/token
  // guard as all other POST endpoints.
  {
    method: 'POST',
    pattern: '/api/cache/clear',
    handler: async ({ res, req }) => {
      const body = await readBody(req);
      const serviceName = typeof body.serviceName === 'string' && body.serviceName.length > 0 ? body.serviceName : undefined;
      const cleared = clearServiceCache(serviceName);
      console.log(`[api] cache/clear${serviceName ? ` (${serviceName})` : ' (all services)'}: ${cleared} row(s) deleted`);
      return json(res, 200, { ok: true, cleared });
    },
  },

  // GET /api/workflow-runs?limit=
  {
    method: 'GET',
    pattern: '/api/workflow-runs',
    handler: ({ res, url }) => {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return json(res, 200, { runs: listRecentWorkflowRuns(limit) });
    },
  },

  // GET /api/workflow-runs/:id  (+ ?after= for incremental framework logs)
  {
    method: 'GET',
    pattern: '/api/workflow-runs/:id',
    handler: ({ res, url, params }) => {
      const run = getWorkflowRun(params.id);
      if (!run) return json(res, 404, { error: 'workflow run not found' });
      const after = Number(url.searchParams.get('after') ?? 0);
      const memberRuns = listRunsForWorkflowRun(params.id);
      // Gates are run-scoped: derive the workflow's gate structure, then classify
      // each against THIS run's member runs (passed / failed / pending). The
      // structure-only /workflows/:name view gets structural gates (no run state).
      const gates = classifyGates(gatesForWorkflow(run.workflow_name), memberRuns);
      return json(res, 200, { run, jobs: memberRuns, logs: getWorkflowLogs(params.id, after), gates });
    },
  },

  // POST /api/workflow-runs/:id/cancel — abort a RUNNING workflow run.
  // Mutating (guarded by authoriseMutation above): hard-kills in-flight member
  // children and stops launching further stages. The run must exist and be
  // 'running' AND be active in this daemon process (present in the executor's
  // registry); the executor records the 'cancelled' transition once it observes
  // the abort. A terminal/unknown run returns a clear error.
  {
    method: 'POST',
    pattern: '/api/workflow-runs/:id/cancel',
    handler: ({ res, params }) => {
      const run = getWorkflowRun(params.id);
      if (!run) return json(res, 404, { error: 'workflow run not found' });
      if (run.status !== 'running') return json(res, 409, { error: `workflow run is ${run.status}, not running` });
      if (!cancelWorkflowRun(params.id)) {
        return json(res, 409, { error: 'workflow run is not active in this process (cannot cancel)' });
      }
      console.log(`[api] cancel requested for workflow run ${params.id}`);
      return json(res, 200, { ok: true });
    },
  },

  // GET /api/workflow-runs/:id/gates/:producer/:key
  // Inspect ONE validation gate for the dashboard's expected-vs-actual view:
  // the classified gate state plus, for each side (produced = producer's
  // `produces[key]`, consumed = consumer's `consumes[key]`), the contract's
  // declared `shape` and a LIVE `check()` of the artifact on disk (per-
  // expectation pass/fail + a small sample of what flowed). Reads files only —
  // never a paid/remote call — so it's safe to poll.
  {
    method: 'GET',
    pattern: '/api/workflow-runs/:id/gates/:producer/:key',
    handler: async ({ res, params }) => {
      const run = getWorkflowRun(params.id);
      if (!run) return json(res, 404, { error: 'workflow run not found' });
      const producer = decodeURIComponent(params.producer);
      const key = decodeURIComponent(params.key);
      const memberRuns = listRunsForWorkflowRun(params.id);
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
    },
  },

  // GET /api/workflow-runs/:id/stage-io?job=<job>
  // Decoupled inputs/outputs for ONE stage of a run (added for stock-digest's
  // workflow-run page, which has a genuine many-to-one aggregation stage that a
  // single joined row can't represent honestly; now the panel every workflow's
  // run page uses). Returns the stage's own work_items rows this run as
  // `outputs` and its direct predecessor(s)' rows this run as `inputs`, with NO
  // attempt to pair them 1:1 — a real 9-row fan-out stays 9 rows. DB reads only.
  {
    method: 'GET',
    pattern: '/api/workflow-runs/:id/stage-io',
    handler: ({ res, url, params }) => {
      const run = getWorkflowRun(params.id);
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
        const inputJobs = rootWave.filter((j) => !outputJobs.includes(j));
        const { inputs, outputs } = stageIoLists(outputJobs, inputJobs, run.id);
        return json(res, 200, { inputs, outputs, predecessorJobs: inputJobs, outputJobs, job: '__overall__' });
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
    },
  },

  // GET /api/workflow-runs/:id/output?job=<job>&key=<key>  (T110)
  // Read-only: return the artifact a job produced for one work item, for the
  // workflow-run IO panel's output preview + full popover. Dispatches on the
  // item's declared output form (detail.format — see CLAUDE.md Output-form
  // convention). The `markdown` form (or unset) is confined via safeOutputMarkdown
  // to a `.md` file in data/out/; any other declared form uses safeOutputFile
  // (same guards, no .md restriction). Both are a pure local file read (no
  // paid/remote calls). "No artifact" is a benign 200 { found: false }.
  {
    method: 'GET',
    pattern: '/api/workflow-runs/:id/output',
    handler: ({ res, url, params }) => {
      const run = getWorkflowRun(params.id);
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
        file: relativePath(WORKFLOWS_ROOT, safe),
        bytes: Buffer.byteLength(content),
        truncated,
        content: truncated ? content.slice(0, MAX) : content,
      });
    },
  },

  // GET /api/services  (usage vs caps + current per-minute rate)
  {
    method: 'GET',
    pattern: '/api/services',
    handler: ({ res }) => {
      const rows = listServices().map((s) => ({
        ...s,
        used_today: serviceCallsToday(s.name),
        used_month: serviceCallsThisMonth(s.name),
        rate_last_min: serviceCallsInLastSeconds(s.name, 60),
      }));
      return json(res, 200, { services: rows });
    },
  },

  // POST /api/services/:name/limits  { rate_per_minute, daily_cap, monthly_cap, timeout_ms }
  // Each value: a non-negative integer, or null (no throttle / no cap / no timeout
  // override). User override — persisted and preserved across code-sync.
  {
    method: 'POST',
    pattern: '/api/services/:name/limits',
    handler: async ({ res, req, params }) => {
      const body = await readBody(req);
      const fields = ['rate_per_minute', 'daily_cap', 'monthly_cap', 'timeout_ms'] as const;
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
      const updated = updateServiceLimits(params.name, limits as unknown as {
        rate_per_minute: number | null; daily_cap: number | null; monthly_cap: number | null; timeout_ms: number | null;
      });
      if (!updated) return json(res, 404, { error: 'service not found' });
      console.log(`[api] service ${params.name} limits updated:`, limits);
      return json(res, 200, { ok: true, service: updated });
    },
  },

  // GET /api/services/:name/consumers — workflows + jobs that have called this service
  {
    method: 'GET',
    pattern: '/api/services/:name/consumers',
    handler: ({ res, params }) => {
      const rows = listServiceConsumers(params.name);
      // Group by workflow for the dashboard view.
      const byWorkflow: Record<string, { workflow_name: string | null; jobs: { job_name: string; last_used: string }[] }> = {};
      for (const r of rows) {
        const wf = r.workflow_name ?? '__none__';
        if (!byWorkflow[wf]) byWorkflow[wf] = { workflow_name: r.workflow_name, jobs: [] };
        byWorkflow[wf].jobs.push({ job_name: r.job_name, last_used: r.last_used });
      }
      return json(res, 200, { consumers: Object.values(byWorkflow) });
    },
  },
];

/**
 * Build the API HTTP server (not yet listening). Split out from `startApi` so
 * tests can drive it on an ephemeral port. `opts.isLoopback` lets a test
 * simulate a non-loopback (remote) caller to exercise the mutation guard.
 */
export function createApiServer(
  opts: {
    isLoopback?: (addr: string | undefined) => boolean;
  } = {},
) {
  const isLoopback = opts.isLoopback ?? isLoopbackAddress;
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
      const match = matchRoute(method, parts, routes);
      if (!match) return json(res, 404, { error: 'not found' });
      await match.route.handler({ req, res, url, parts, params: match.params });
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
