import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { type Gate, buildDag, classifyGates, deriveGates } from '../core/dag.js';
import { runJob } from '../core/executor.js';
import { runPipeline } from '../core/pipeline-executor.js';
import { nextPipelineRun, nextRun } from '../core/scheduler.js';
import { getJobDefinition, getPipelineDefinition } from '../jobs/registry.js';
import {
  browseTable,
  getLogs,
  getPipeline,
  getPipelineJobs,
  getPipelineLogs,
  getPipelineRun,
  getRun,
  lastPipelineRunForPipeline,
  lastRunForJob,
  listJobs,
  listPipelineRunsForPipeline,
  listPipelines,
  listRecentPipelineRuns,
  listRecentRuns,
  listRunsForJob,
  listRunsForPipelineRun,
  listDbTables,
  listServices,
  orphanedWorkItems,
  pruneOrphanedWorkItems,
  serviceCallsInLastSeconds,
  serviceCallsThisMonth,
  serviceCallsToday,
  updateServiceLimits,
  setJobEnabled,
  setPipelineEnabled,
  stuckCount,
  stuckItems,
  unstickWorkItem,
  ignoreWorkItem,
  ignoredItems,
} from '../db/store.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  // CORS headers are applied per-request by applyCors() via res.setHeader before
  // routing, so we only set the content type here (writeHead merges with those).
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

// The harness backlog (.harness/TASKS.json), resolved relative to this file so it
// works regardless of the daemon's cwd. Read-only pass-through for the dashboard.
const BACKLOG_PATH = fileURLToPath(new URL('../../.harness/TASKS.json', import.meta.url));
function readBacklog(): { tasks: unknown[]; error?: string } {
  try {
    const parsed = JSON.parse(readFileSync(BACKLOG_PATH, 'utf8')) as { tasks?: unknown[] };
    return { tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
  } catch (e) {
    return { tasks: [], error: e instanceof Error ? e.message : 'cannot read backlog' };
  }
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

/** Decorate a job row with its last run, next scheduled time, and instructions. */
function jobView(name: string) {
  const def = getJobDefinition(name);
  return {
    last_run: lastRunForJob(name) ?? null,
    next_run: nextRun(name),
    has_def: !!def,
    instructions: def?.instructions ?? null,
    stuck: stuckCount(name),
  };
}

/** Decorate a pipeline with its last/next run, member jobs+edges, and total stuck. */
function pipelineView(name: string) {
  const members = getPipelineJobs(name);
  return {
    last_run: lastPipelineRunForPipeline(name) ?? null,
    next_run: nextPipelineRun(name),
    jobs: members,
    stuck: members.reduce((sum, m) => sum + stuckCount(m.job_name), 0),
  };
}

/**
 * Derive the validation gates for a pipeline from its members' declared
 * produces/consumes contracts (the same `deriveGates` the executor enforces).
 * Pure structure — gate STATE is layered on per-run by `classifyGates`. A
 * malformed DAG yields no gates (the run endpoint surfaces the DAG error itself).
 */
function gatesForPipeline(name: string): Gate[] {
  const refs = getPipelineJobs(name).map((m) => ({ job: m.job_name, dependsOn: m.depends_on }));
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
  return deriveGates(dag, produces, consumes);
}

/** Map each pipeline member job → its pipeline name (for grouping the jobs list). */
function memberPipelineMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of listPipelines()) for (const m of getPipelineJobs(p.name)) map.set(m.job_name, p.name);
  return map;
}

/**
 * Build the API HTTP server (not yet listening). Split out from `startApi` so
 * tests can drive it on an ephemeral port. `opts.isLoopback` lets a test
 * simulate a non-loopback (remote) caller to exercise the mutation guard.
 */
export function createApiServer(opts: { isLoopback?: (addr: string | undefined) => boolean } = {}) {
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

      // GET /api/stuck  (optionally ?job=<name>) — items that gave up, won't retry
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'stuck' && parts.length === 2) {
        const jobFilter = url.searchParams.get('job');
        const items = stuckItems().filter((i) => !jobFilter || i.job_name === jobFilter);
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

      // GET /api/ignored  (optionally ?job=<name>) — manually-parked items
      // (overview-only; never counted as stuck)
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'ignored' && parts.length === 2) {
        const jobFilter = url.searchParams.get('job');
        const items = ignoredItems().filter((i) => !jobFilter || i.job_name === jobFilter);
        return json(res, 200, { ignored: items });
      }

      // GET /api/jobs  (each flagged with its pipeline, if it's a member)
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'jobs' && parts.length === 2) {
        const memberOf = memberPipelineMap();
        const rows = listJobs().map((j) => ({ ...j, ...jobView(j.name), pipeline: memberOf.get(j.name) ?? null }));
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

      // POST /api/jobs/:name/run
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'jobs' && parts[3] === 'run') {
        const def = getJobDefinition(parts[2]);
        if (!def) return json(res, 404, { error: 'job not found' });
        // Fire-and-forget: respond immediately, run happens in the daemon.
        runJob(def, 'manual').catch((e) => console.error('[api] run error', e));
        return json(res, 202, { ok: true, message: 'run started' });
      }

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

      // POST /api/jobs/:name/toggle  { enabled: boolean }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'jobs' && parts[3] === 'toggle') {
        const body = await readBody(req);
        setJobEnabled(parts[2], !!body.enabled);
        return json(res, 200, { ok: true, enabled: !!body.enabled });
      }

      // GET /api/pipelines
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'pipelines' && parts.length === 2) {
        const rows = listPipelines().map((p) => ({ ...p, ...pipelineView(p.name) }));
        return json(res, 200, { pipelines: rows });
      }

      // GET /api/pipelines/:name/runs
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'pipelines' && parts[3] === 'runs') {
        return json(res, 200, { runs: listPipelineRunsForPipeline(parts[2]) });
      }

      // GET /api/pipelines/:name
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'pipelines' && parts.length === 3) {
        const p = getPipeline(parts[2]);
        if (!p) return json(res, 404, { error: 'pipeline not found' });
        return json(res, 200, { pipeline: { ...p, ...pipelineView(p.name), runs: listPipelineRunsForPipeline(p.name, 20) } });
      }

      // POST /api/pipelines/:name/run
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'pipelines' && parts[3] === 'run') {
        const def = getPipelineDefinition(parts[2]);
        if (!def) return json(res, 404, { error: 'pipeline not found' });
        runPipeline(def, 'manual').catch((e) => console.error('[api] pipeline run error', e));
        return json(res, 202, { ok: true, message: 'pipeline run started' });
      }

      // POST /api/pipelines/:name/toggle  { enabled }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'pipelines' && parts[3] === 'toggle') {
        const body = await readBody(req);
        setPipelineEnabled(parts[2], !!body.enabled);
        return json(res, 200, { ok: true, enabled: !!body.enabled });
      }

      // GET /api/pipeline-runs?limit=
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'pipeline-runs' && parts.length === 2) {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        return json(res, 200, { runs: listRecentPipelineRuns(limit) });
      }

      // GET /api/pipeline-runs/:id  (+ ?after= for incremental framework logs)
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'pipeline-runs' && parts.length === 3) {
        const run = getPipelineRun(parts[2]);
        if (!run) return json(res, 404, { error: 'pipeline run not found' });
        const after = Number(url.searchParams.get('after') ?? 0);
        const memberRuns = listRunsForPipelineRun(parts[2]);
        // Gates are run-scoped: derive the pipeline's gate structure, then classify
        // each against THIS run's member runs (passed / failed / pending). The
        // structure-only /pipelines/:name view never gets these.
        const gates = classifyGates(gatesForPipeline(run.pipeline_name), memberRuns);
        return json(res, 200, { run, jobs: memberRuns, logs: getPipelineLogs(parts[2], after), gates });
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

      // GET /api/backlog — the harness TASKS.json backlog (read-only)
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'backlog' && parts.length === 2) {
        return json(res, 200, readBacklog());
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
