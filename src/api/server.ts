import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config } from '../config.js';
import { runJob } from '../core/executor.js';
import { nextRun } from '../core/scheduler.js';
import { getJobDefinition } from '../jobs/registry.js';
import {
  getLogs,
  getRun,
  lastRunForJob,
  listJobs,
  listRecentRuns,
  listRunsForJob,
  setJobEnabled,
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
  };
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

      // GET /api/jobs
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'jobs' && parts.length === 2) {
        const rows = listJobs().map((j) => ({ ...j, ...jobView(j.name) }));
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

      // POST /api/jobs/:name/toggle  { enabled: boolean }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'jobs' && parts[3] === 'toggle') {
        const body = await readBody(req);
        setJobEnabled(parts[2], !!body.enabled);
        return json(res, 200, { ok: true, enabled: !!body.enabled });
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
