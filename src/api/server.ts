import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { type Gate, buildDag, classifyGates, deriveGates } from '../core/dag.js';
import type { GateResult } from '../core/types.js';
import { runWorkflow, cancelWorkflowRun } from '../core/workflow-executor.js';
import { nextWorkflowRun } from '../core/scheduler.js';
import { getJobDefinition, getWorkflowDefinition } from '../jobs/registry.js';
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
  serviceCallsInLastSeconds,
  serviceCallsThisMonth,
  serviceCallsToday,
  updateServiceLimits,
  setWorkflowEnabled,
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
function readBacklog(): { tasks: unknown[]; defaults?: unknown; error?: string } {
  try {
    const parsed = JSON.parse(readFileSync(BACKLOG_PATH, 'utf8')) as { tasks?: unknown[]; defaults?: unknown };
    return { tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [], defaults: parsed.defaults };
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
    const parts = [pd && `output: ${pd}`, cd && `input: ${cd}`].filter(Boolean) as string[];
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
        return json(res, 200, { workflow: { ...p, ...workflowView(p.name), gates: gatesForWorkflow(p.name), runs: listWorkflowRunsForWorkflow(p.name, 20) } });
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
        runWorkflow(def, 'manual', { limit }).catch((e) => console.error('[api] workflow run error', e));
        return json(res, 202, { ok: true, message: 'workflow run started', limit: limit ?? null });
      }

      // POST /api/workflows/:name/toggle  { enabled }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workflows' && parts[3] === 'toggle') {
        const body = await readBody(req);
        setWorkflowEnabled(parts[2], !!body.enabled);
        return json(res, 200, { ok: true, enabled: !!body.enabled });
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
      // the classified gate state plus, for each side (output = producer's
      // `produces[key]`, input = consumer's `consumes[key]`), the contract's
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
        const output = await inspectSide(gate.producer, 'produces');
        const input = await inspectSide(gate.consumer, 'consumes');
        return json(res, 200, { gate, output, input });
      }

      // GET /api/workflow-runs/:id/io
      // First-cut input→output mapping for a workflow run (T095). Reads the
      // first- and last-wave jobs' work_items and joins them by root_key so
      // each input key is paired with its output. DB/file reads only — safe to
      // poll. Known limitation: work_items is not scoped per run; this reflects
      // the workflow's global ledger. Fan-out collapses to the first match.
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
          return json(res, 200, { io: [], firstWave: [], lastWave: [], note: 'workflow DAG could not be parsed' });
        }
        const io = workItemIoRows(firstWave, lastWave);
        return json(res, 200, {
          io,
          firstWave,
          lastWave,
          // Surface the limitation so the UI can label the panel clearly.
          note: 'First-cut mapping: reflects the global work-item ledger, not scoped to this run. Fan-out collapses to one output per input.',
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
