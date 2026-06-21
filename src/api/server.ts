import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config } from '../config.js';
import { runJob } from '../core/executor.js';
import { runPipeline } from '../core/pipeline-executor.js';
import { nextPipelineRun, nextRun } from '../core/scheduler.js';
import { getJobDefinition, getPipelineDefinition } from '../jobs/registry.js';
import {
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
  listServices,
  orphanedWorkItems,
  pruneOrphanedWorkItems,
  serviceCallsInLastSeconds,
  serviceCallsThisMonth,
  serviceCallsToday,
  setJobEnabled,
  setPipelineEnabled,
  stuckCount,
  stuckItems,
  unstickWorkItem,
} from '../db/store.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
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

/** Map each pipeline member job → its pipeline name (for grouping the jobs list). */
function memberPipelineMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of listPipelines()) for (const m of getPipelineJobs(p.name)) map.set(m.job_name, p.name);
  return map;
}

export function startApi(): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${config.apiPort}`);
    const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','jobs','demo','runs']
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') return json(res, 204, {});

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
        return json(res, 200, { run, jobs: listRunsForPipelineRun(parts[2]), logs: getPipelineLogs(parts[2], after) });
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

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('[api] error', err);
      return json(res, 500, { error: err instanceof Error ? err.message : 'internal error' });
    }
  });

  server.listen(config.apiPort, '127.0.0.1', () => {
    console.log(`[api] listening on http://127.0.0.1:${config.apiPort}`);
  });
}
