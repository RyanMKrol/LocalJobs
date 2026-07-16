// Unit + integration tests for the API's security hardening (T023): CORS is an
// allowlist (never '*'), the server binds loopback by default, and mutating (POST)
// endpoints reject unauthorised callers. The pure helpers are tested directly; an
// ephemeral real server exercises the CORS reflection and the 401 guard end-to-end.
// `opts.isLoopback` lets us simulate a remote (non-loopback) caller without a second host.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { jobs, workflows } from '../workflows/registry.js';
import { createWorkflowRun, finishWorkflowRun, getJob, getWorkflow, lastWorkflowRunForWorkflow, markWorkItem, recordServiceConsumer, syncJob, syncWorkflow } from '../db/store.js';
import { nextWorkflowRun, rescheduleWorkflow } from '../core/scheduler.js';
import { isWorkflowStarting } from '../core/workflow-executor.js';
import type { ArtifactShape, JobDefinition, WorkflowDefinition } from '../core/types.js';
import {
  authoriseMutation,
  createApiServer,
  isLoopbackAddress,
  isWithin,
  originAllowed,
  safeOutputFile,
  safeOutputMarkdown,
} from './server.js';

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.stack : e}`);
    process.exitCode = 1;
  }
}

// Boot a server on an ephemeral port, run `fn` against its base URL, always close.
async function withServer(
  opts: Parameters<typeof createApiServer>[0],
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = createApiServer(opts);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
  }
}

// ── pure helpers ──
await test('originAllowed: only allowlisted origins pass; never wildcard', () => {
  const allow = ['http://localhost:4788', 'http://127.0.0.1:4788'];
  assert.equal(originAllowed('http://localhost:4788', allow), true);
  assert.equal(originAllowed('http://evil.example', allow), false);
  assert.equal(originAllowed(undefined, allow), false);
  assert.equal(originAllowed('*', allow), false);
});

await test('isLoopbackAddress: recognises the loopback spellings Node reports', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('100.64.0.5'), false); // a Tailscale CGNAT addr
  assert.equal(isLoopbackAddress(undefined), false);
});

await test('authoriseMutation: loopback always allowed', () => {
  assert.equal(authoriseMutation({ remoteAddress: '127.0.0.1', headers: {}, token: '' }), true);
  assert.equal(authoriseMutation({ remoteAddress: '::1', headers: {}, token: 'secret' }), true);
});

await test('authoriseMutation: remote caller is REJECTED without a valid token', () => {
  // no token configured → no remote mutation possible
  assert.equal(authoriseMutation({ remoteAddress: '100.64.0.5', headers: {}, token: '' }), false);
  // token configured but caller sends none / wrong one
  assert.equal(authoriseMutation({ remoteAddress: '100.64.0.5', headers: {}, token: 'secret' }), false);
  assert.equal(
    authoriseMutation({ remoteAddress: '100.64.0.5', headers: { 'x-localjobs-token': 'nope' }, token: 'secret' }),
    false,
  );
});

await test('authoriseMutation: remote caller with the right token (header or bearer) is allowed', () => {
  assert.equal(
    authoriseMutation({ remoteAddress: '100.64.0.5', headers: { 'x-localjobs-token': 'secret' }, token: 'secret' }),
    true,
  );
  assert.equal(
    authoriseMutation({ remoteAddress: '100.64.0.5', headers: { authorization: 'Bearer secret' }, token: 'secret' }),
    true,
  );
});

// ── integration: CORS reflection ──
await test('CORS: an allowed Origin is reflected (not wildcarded)', async () => {
  await withServer({}, async (base) => {
    const allowed = config.allowedOrigins[0];
    const res = await fetch(`${base}/api/health`, { headers: { Origin: allowed } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), allowed);
    assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
  });
});

await test('CORS: a disallowed Origin gets NO Access-Control-Allow-Origin', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(res.status, 200); // request itself still served; the BROWSER blocks it
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

await test('GET /api returns the live route table with { method, pattern } entries', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { routes: { method: string; pattern: string }[] };
    assert.ok(Array.isArray(body.routes));
    assert.ok(body.routes.length > 0);
    for (const r of body.routes) {
      assert.equal(typeof r.method, 'string');
      assert.equal(typeof r.pattern, 'string');
    }
    assert.ok(body.routes.some((r) => r.method === 'GET' && r.pattern === '/api/workflows/:name'));
  });
});

// ── integration: mutation guard ──
await test('mutation guard: a remote POST with no token is rejected 401', async () => {
  await withServer({ isLoopback: () => false }, async (base) => {
    const prev = config.authToken;
    config.authToken = '';
    try {
      const res = await fetch(`${base}/api/workflows/__no_such_workflow__/run`, { method: 'POST' });
      assert.equal(res.status, 401);
    } finally {
      config.authToken = prev;
    }
  });
});

await test('mutation guard: a remote POST with the right token passes the guard', async () => {
  await withServer({ isLoopback: () => false }, async (base) => {
    const prev = config.authToken;
    config.authToken = 'secret';
    try {
      // Unknown workflow → 404 means the guard let it through to routing (not 401).
      const res = await fetch(`${base}/api/workflows/__no_such_workflow__/run`, {
        method: 'POST',
        headers: { 'X-LocalJobs-Token': 'secret' },
      });
      assert.equal(res.status, 404);
    } finally {
      config.authToken = prev;
    }
  });
});

await test('mutation guard: a loopback POST passes the guard (default isLoopback)', async () => {
  await withServer({}, async (base) => {
    // Real connection is from 127.0.0.1 → loopback → allowed; unknown workflow → 404, not 401.
    const res = await fetch(`${base}/api/workflows/__no_such_workflow__/run`, { method: 'POST' });
    assert.equal(res.status, 404);
  });
});

// ── run-limit (T094): the workflow view advertises limitability + the run
// endpoint validates a manual limit BEFORE starting a run (so an invalid limit
// never spawns anything). Self-contained: a fake limitable workflow (root stage
// declares inputKeys()) + a plain one, registered then cleaned up so the registry
// job count other tests assert stays correct. ──
{
  const limRoot: JobDefinition = { name: 'srv-lim-root', inputKeys: () => ['a', 'b'], run: async () => {} };
  const plain: JobDefinition = { name: 'srv-plain', run: async () => {} };
  for (const d of [limRoot, plain]) { syncJob(d); jobs.push(d); }
  const limWf: WorkflowDefinition = { name: 'srv-lim-wf', jobs: [{ job: 'srv-lim-root' }] };
  const plainWf: WorkflowDefinition = { name: 'srv-plain-wf', jobs: [{ job: 'srv-plain' }] };
  for (const w of [limWf, plainWf]) { syncWorkflow(w); workflows.push(w); } // registry resolves /run via this array

  await test('run-limit: a workflow with a root stage advertises limitable: true; a plain one false', async () => {
    await withServer({}, async (base) => {
      const lim = (await (await fetch(`${base}/api/workflows/srv-lim-wf`)).json()) as { workflow: { limitable?: boolean } };
      assert.equal(lim.workflow.limitable, true, 'root stage declares inputKeys → limitable');
      const pl = (await (await fetch(`${base}/api/workflows/srv-plain-wf`)).json()) as { workflow: { limitable?: boolean } };
      assert.equal(pl.workflow.limitable, false, 'no inputKeys member → not limitable');
    });
  });

  await test('run-limit: a non-positive / non-integer limit is rejected 400 (no run started)', async () => {
    await withServer({}, async (base) => {
      for (const limit of [0, -3, 1.5, 'abc']) {
        const res = await fetch(`${base}/api/workflows/srv-lim-wf/run`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit }),
        });
        assert.equal(res.status, 400, `limit=${limit} rejected`);
        assert.match(((await res.json()) as { error?: string }).error ?? '', /limit must be a positive integer/);
      }
    });
  });

  await test('run-limit: a limit on a non-limitable workflow is rejected 400 (no run started)', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/srv-plain-wf/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 2 }),
      });
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error?: string }).error ?? '', /cannot be limited/);
    });
  });

  for (const d of [limRoot, plain]) { const i = jobs.indexOf(d); if (i >= 0) jobs.splice(i, 1); }
  for (const w of [limWf, plainWf]) { const i = workflows.indexOf(w); if (i >= 0) workflows.splice(i, 1); }
}

// ── editable schedule (T135): POST /api/workflows/:name/schedule validates the cron
// server-side, persists a user override, and live-reschedules. A self-contained fake
// workflow registered then cleaned up (and its cron cleared) so other tests are
// unaffected. ──
{
  const schedJob: JobDefinition = { name: 'sched-api-job', run: async () => {} };
  syncJob(schedJob); jobs.push(schedJob);
  const schedWf: WorkflowDefinition = { name: 'sched-api-wf', schedule: '0 3 * * *', jobs: [{ job: 'sched-api-job' }] };
  syncWorkflow(schedWf); workflows.push(schedWf); // registry resolves rescheduleWorkflow's def lookup via this array

  await test('schedule: a valid cron is accepted (200), persisted + overridden, returns next_run', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/sched-api-wf/schedule`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule: '30 4 * * *' }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; schedule: string | null; next_run: string | null };
      assert.equal(body.schedule, '30 4 * * *');
      assert.ok(body.next_run, 'a next_run is computed for the new cron');
      assert.equal(getWorkflow('sched-api-wf')?.schedule, '30 4 * * *', 'persisted to the DB');
      assert.equal(getWorkflow('sched-api-wf')?.schedule_overridden, 1, 'flagged as user-overridden');
      assert.ok(nextWorkflowRun('sched-api-wf'), 'live scheduler re-registered the cron');
    });
  });

  await test('schedule: an empty value clears to manual-only (null schedule, null next_run)', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/sched-api-wf/schedule`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule: '   ' }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { schedule: string | null; next_run: string | null };
      assert.equal(body.schedule, null, 'blank → manual-only');
      assert.equal(body.next_run, null, 'no next run when manual-only');
      assert.equal(getWorkflow('sched-api-wf')?.schedule, null);
      assert.equal(nextWorkflowRun('sched-api-wf'), null, 'cron removed from the live scheduler');
    });
  });

  await test('schedule: an invalid cron is rejected 400 and never reaches the scheduler', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/sched-api-wf/schedule`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule: 'not a cron' }),
      });
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error?: string }).error ?? '', /invalid cron/);
      assert.equal(getWorkflow('sched-api-wf')?.schedule, null, 'bad value not persisted (still manual-only from prior test)');
      assert.equal(nextWorkflowRun('sched-api-wf'), null, 'no cron registered for the bad value');
    });
  });

  await test('schedule: unknown workflow → 404', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/__no_such_wf__/schedule`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule: '0 1 * * *' }),
      });
      assert.equal(res.status, 404);
    });
  });

  rescheduleWorkflow('sched-api-wf', null); // clear any live cron this test left registered
  { const i = jobs.indexOf(schedJob); if (i >= 0) jobs.splice(i, 1); }
  { const i = workflows.indexOf(schedWf); if (i >= 0) workflows.splice(i, 1); }
}

// ── editable job timeoutMs (T297): POST /api/jobs/:name/timeout validates + persists
// a user override, mirroring the schedule override tests above. ──
{
  const timeoutJob: JobDefinition = { name: 'timeout-api-job', timeoutMs: 60_000, run: async () => {} };
  syncJob(timeoutJob); jobs.push(timeoutJob);

  await test('job timeout: a valid non-negative integer is accepted (200), persisted + overridden', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/jobs/timeout-api-job/timeout`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timeoutMs: 120_000 }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; job: { timeout_ms: number } };
      assert.equal(body.job.timeout_ms, 120_000);
      assert.equal(getJob('timeout-api-job')?.timeout_ms, 120_000, 'persisted to the DB');
      assert.equal(getJob('timeout-api-job')?.timeout_ms_overridden, 1, 'flagged as user-overridden');
    });
  });

  await test('job timeout: 0 is accepted (no timeout)', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/jobs/timeout-api-job/timeout`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timeoutMs: 0 }),
      });
      assert.equal(res.status, 200);
      assert.equal(getJob('timeout-api-job')?.timeout_ms, 0);
    });
  });

  await test('job timeout: a negative value is rejected 400 and never persisted', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/jobs/timeout-api-job/timeout`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timeoutMs: -5 }),
      });
      assert.equal(res.status, 400);
      assert.equal(getJob('timeout-api-job')?.timeout_ms, 0, 'unchanged from the prior test');
    });
  });

  await test('job timeout: a non-integer value is rejected 400', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/jobs/timeout-api-job/timeout`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timeoutMs: 12.5 }),
      });
      assert.equal(res.status, 400);
    });
  });

  await test('job timeout: unknown job → 404', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/jobs/__no_such_job__/timeout`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timeoutMs: 1000 }),
      });
      assert.equal(res.status, 404);
    });
  });

  { const i = jobs.indexOf(timeoutJob); if (i >= 0) jobs.splice(i, 1); }
}

// ── editable maxConcurrency (T169): POST /api/workflows/:name/concurrency validates
// (≥ 1 integer) server-side, persists a user override, and surfaces the effective
// value on the GET payload. ──
{
  const concJob: JobDefinition = { name: 'conc-api-job', run: async () => {} };
  syncJob(concJob); jobs.push(concJob);
  const concWf: WorkflowDefinition = { name: 'conc-api-wf', maxConcurrency: 4, jobs: [{ job: 'conc-api-job' }] };
  syncWorkflow(concWf); workflows.push(concWf);

  await test('concurrency: a valid value is accepted (200), persisted + overridden, surfaced on GET', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/conc-api-wf/concurrency`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxConcurrency: 2 }),
      });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { max_concurrency: number }).max_concurrency, 2);
      assert.equal(getWorkflow('conc-api-wf')?.max_concurrency, 2, 'persisted to the DB');
      assert.equal(getWorkflow('conc-api-wf')?.max_concurrency_overridden, 1, 'flagged as user-overridden');
      const get = await fetch(`${base}/api/workflows/conc-api-wf`);
      const wf = ((await get.json()) as { workflow: { effective_max_concurrency: number } }).workflow;
      assert.equal(wf.effective_max_concurrency, 2, 'effective value surfaced on the workflow payload');
    });
  });

  for (const bad of [-1, 1.5, 'x'] as const) {
    await test(`concurrency: an invalid value (${bad}) is rejected 400`, async () => {
      await withServer({}, async (base) => {
        const res = await fetch(`${base}/api/workflows/conc-api-wf/concurrency`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxConcurrency: bad }),
        });
        assert.equal(res.status, 400);
        assert.match(((await res.json()) as { error?: string }).error ?? '', /positive integer/);
      });
    });
  }

  // T201: sentinel 0 means unlimited — accepted (200), not rejected.
  await test('concurrency: sentinel 0 (unlimited) is accepted 200', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/conc-api-wf/concurrency`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxConcurrency: 0 }),
      });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { max_concurrency?: number }).max_concurrency, 0);
    });
  });

  await test('concurrency: unknown workflow → 404', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/__no_such_wf__/concurrency`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxConcurrency: 2 }),
      });
      assert.equal(res.status, 404);
    });
  });

  { const i = jobs.indexOf(concJob); if (i >= 0) jobs.splice(i, 1); }
  { const i = workflows.indexOf(concWf); if (i >= 0) workflows.splice(i, 1); }
}

// ── editable notifyEnabled (T285): POST /api/workflows/:name/notify validates
// (boolean) server-side, persists a user override, and surfaces the effective
// value on the GET payload. ──
{
  const notifyJob: JobDefinition = { name: 'notify-api-job', run: async () => {} };
  syncJob(notifyJob); jobs.push(notifyJob);
  const notifyWf: WorkflowDefinition = { name: 'notify-api-wf', jobs: [{ job: 'notify-api-job' }] };
  syncWorkflow(notifyWf); workflows.push(notifyWf);

  await test('notify: a valid value is accepted (200), persisted + overridden, surfaced on GET', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/notify-api-wf/notify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifyEnabled: false }),
      });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { notify_enabled: boolean }).notify_enabled, false);
      assert.equal(getWorkflow('notify-api-wf')?.notify_enabled, 0, 'persisted to the DB');
      assert.equal(getWorkflow('notify-api-wf')?.notify_enabled_overridden, 1, 'flagged as user-overridden');
      const get = await fetch(`${base}/api/workflows/notify-api-wf`);
      const wf = ((await get.json()) as { workflow: { effective_notify_enabled: boolean } }).workflow;
      assert.equal(wf.effective_notify_enabled, false, 'effective value surfaced on the workflow payload');
    });
  });

  for (const bad of [1, 'x', null] as const) {
    await test(`notify: a non-boolean value (${bad}) is rejected 400`, async () => {
      await withServer({}, async (base) => {
        const res = await fetch(`${base}/api/workflows/notify-api-wf/notify`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifyEnabled: bad }),
        });
        assert.equal(res.status, 400);
        assert.match(((await res.json()) as { error?: string }).error ?? '', /boolean/);
      });
    });
  }

  await test('notify: unknown workflow → 404', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/__no_such_wf__/notify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifyEnabled: true }),
      });
      assert.equal(res.status, 404);
    });
  });

  { const i = jobs.indexOf(notifyJob); if (i >= 0) jobs.splice(i, 1); }
  { const i = workflows.indexOf(notifyWf); if (i >= 0) workflows.splice(i, 1); }
}

// ── plain user-set certified flag (T497): POST /api/workflows/:name/certify
// validates (boolean) server-side, persists via setWorkflowCertified, and is
// surfaced on both the GET detail and GET list payloads with no extra wiring
// (both already spread the raw row). ──
{
  const certifyJob: JobDefinition = { name: 'certify-api-job', run: async () => {} };
  syncJob(certifyJob); jobs.push(certifyJob);
  const certifyWf: WorkflowDefinition = { name: 'certify-api-wf', jobs: [{ job: 'certify-api-job' }] };
  syncWorkflow(certifyWf); workflows.push(certifyWf);

  await test('certify: a valid value is accepted (200), persisted, surfaced on GET detail + list', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/certify-api-wf/certify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ certified: true }),
      });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { certified: boolean }).certified, true);
      assert.equal(getWorkflow('certify-api-wf')?.certified, 1, 'persisted to the DB');

      const get = await fetch(`${base}/api/workflows/certify-api-wf`);
      const wf = ((await get.json()) as { workflow: { certified?: number } }).workflow;
      assert.equal(wf.certified, 1, 'certified surfaced on the workflow detail payload');

      const list = await fetch(`${base}/api/workflows`);
      const body = (await list.json()) as { workflows: { name: string; certified?: number }[] };
      const row = body.workflows.find((w) => w.name === 'certify-api-wf');
      assert.equal(row?.certified, 1, 'certified surfaced on the workflow list payload');
    });
  });

  for (const bad of [1, 'x', null] as const) {
    await test(`certify: a non-boolean value (${bad}) is rejected 400`, async () => {
      await withServer({}, async (base) => {
        const res = await fetch(`${base}/api/workflows/certify-api-wf/certify`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ certified: bad }),
        });
        assert.equal(res.status, 400);
        assert.match(((await res.json()) as { error?: string }).error ?? '', /boolean/);
      });
    });
  }

  await test('certify: unknown workflow → 404', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/__no_such_wf__/certify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ certified: true }),
      });
      assert.equal(res.status, 404);
    });
  });

  { const i = jobs.indexOf(certifyJob); if (i >= 0) jobs.splice(i, 1); }
  { const i = workflows.indexOf(certifyWf); if (i >= 0) workflows.splice(i, 1); }
}

// ── T595: while a limited manual run is awaiting its root stage's inputKeys()
// (the pre-DB-row window), both GET /api/workflows and GET /api/workflows/:name
// surface `starting: true` — clearing back to false once the run row exists. ──
{
  let releaseInputKeys: (() => void) | null = null;
  const startingJob: JobDefinition = {
    name: 'starting-api-job',
    inputKeys: () =>
      new Promise<string[]>((resolve) => {
        releaseInputKeys = () => resolve(['only-key']);
      }),
    run: async () => {},
  };
  syncJob(startingJob); jobs.push(startingJob);
  const startingWf: WorkflowDefinition = { name: 'starting-api-wf', jobs: [{ job: 'starting-api-job' }] };
  syncWorkflow(startingWf); workflows.push(startingWf);

  await test('starting: POST /run with a limit sets starting:true on both GET payloads before the run row exists, then clears it', async () => {
    await withServer({}, async (base) => {
      assert.equal(isWorkflowStarting('starting-api-wf'), false, 'not starting before the run is triggered');

      const runRes = await fetch(`${base}/api/workflows/starting-api-wf/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 1 }),
      });
      assert.equal(runRes.status, 202, 'run accepted immediately (fire-and-forget)');

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !isWorkflowStarting('starting-api-wf')) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(isWorkflowStarting('starting-api-wf'), true, 'claim registered while inputKeys() is pending');
      assert.equal(lastWorkflowRunForWorkflow('starting-api-wf'), undefined, 'no workflow_runs row yet');

      const get = await fetch(`${base}/api/workflows/starting-api-wf`);
      const wf = ((await get.json()) as { workflow: { starting?: boolean } }).workflow;
      assert.equal(wf.starting, true, 'detail payload surfaces starting:true during the pre-DB-row window');

      const list = await fetch(`${base}/api/workflows`);
      const body = (await list.json()) as { workflows: { name: string; starting?: boolean }[] };
      const row = body.workflows.find((w) => w.name === 'starting-api-wf');
      assert.equal(row?.starting, true, 'list payload surfaces starting:true during the pre-DB-row window');

      // Release the hanging inputKeys() and let the run settle.
      assert.ok(releaseInputKeys, 'release hook captured');
      releaseInputKeys!();
      const settleDeadline = Date.now() + 5000;
      while (Date.now() < settleDeadline && isWorkflowStarting('starting-api-wf')) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(isWorkflowStarting('starting-api-wf'), false, 'starting clears once the run settles');
      assert.ok(lastWorkflowRunForWorkflow('starting-api-wf'), 'a workflow_runs row now exists');

      const get2 = await fetch(`${base}/api/workflows/starting-api-wf`);
      const wf2 = ((await get2.json()) as { workflow: { starting?: boolean } }).workflow;
      assert.equal(wf2.starting, false, 'detail payload falls back to normal (starting:false) after settle');
    });
  });

  { const i = jobs.indexOf(startingJob); if (i >= 0) jobs.splice(i, 1); }
  { const i = workflows.indexOf(startingWf); if (i >= 0) workflows.splice(i, 1); }
}

// ── T291: GET /api/workflows (the list endpoint) must surface the EFFECTIVE
// notify-enabled value (via effectiveWorkflowNotifyEnabled), computed the same
// way the single-workflow detail endpoint already does, rather than omitting it
// or leaking the raw integer DB column. Seed a workflow with a manifest default
// of notifyEnabled:false, not user-overridden, and confirm the list endpoint's
// effective_notify_enabled reflects that manifest default. ──
{
  const notifyListJob: JobDefinition = { name: 'notify-list-job', run: async () => {} };
  syncJob(notifyListJob); jobs.push(notifyListJob);
  const notifyListWf: WorkflowDefinition = { name: 'notify-list-wf', jobs: [{ job: 'notify-list-job' }], notifyEnabled: false };
  syncWorkflow(notifyListWf); workflows.push(notifyListWf);

  await test('T291: GET /api/workflows exposes effective_notify_enabled reflecting the manifest default', async () => {
    await withServer({}, async (base) => {
      assert.equal(getWorkflow('notify-list-wf')?.notify_enabled, 0, 'raw DB column seeded from the manifest default');
      assert.equal(getWorkflow('notify-list-wf')?.notify_enabled_overridden, 0, 'not user-overridden');
      const res = await fetch(`${base}/api/workflows`);
      const body = (await res.json()) as { workflows: { name: string; effective_notify_enabled?: boolean }[] };
      const row = body.workflows.find((w) => w.name === 'notify-list-wf');
      assert.ok(row, 'workflow present in the list response');
      assert.equal(row!.effective_notify_enabled, false, 'effective value reflects the manifest default, computed via effectiveWorkflowNotifyEnabled');
    });
  });

  { const i = jobs.indexOf(notifyListJob); if (i >= 0) jobs.splice(i, 1); }
  { const i = workflows.indexOf(notifyListWf); if (i >= 0) workflows.splice(i, 1); }
}

// ── one active run per workflow (T105): POST /api/workflows/:name/run must reject
// a duplicate start with 409 while a run is already active, instead of appearing to
// start a second run. A seeded 'running' workflow_run row makes the guard observe an
// active run WITHOUT spawning a child; it's cleaned up afterwards so other tests are
// unaffected. ──
{
  const guardJob: JobDefinition = { name: 'guard-api-job', run: async () => {} };
  syncJob(guardJob); jobs.push(guardJob);
  const guardWf: WorkflowDefinition = { name: 'guard-api-wf', jobs: [{ job: 'guard-api-job' }] };
  syncWorkflow(guardWf); workflows.push(guardWf);

  await test('one active run per workflow: POST /run is rejected 409 while a run is active (no second run started)', async () => {
    const wrid = createWorkflowRun('guard-api-wf', 'manual'); // status 'running'
    try {
      await withServer({}, async (base) => {
        const res = await fetch(`${base}/api/workflows/guard-api-wf/run`, { method: 'POST' });
        assert.equal(res.status, 409, 'duplicate start rejected with 409 Conflict');
        const body = (await res.json()) as { error?: string; running?: boolean };
        assert.match(body.error ?? '', /already has an active run/);
        assert.equal(body.running, true, 'response flags the workflow as running');
      });
    } finally {
      finishWorkflowRun(wrid, 'cancelled'); // release the active run for other tests
    }
  });

  const i = jobs.indexOf(guardJob); if (i >= 0) jobs.splice(i, 1);
  const j = workflows.indexOf(guardWf); if (j >= 0) workflows.splice(j, 1);
}

// ── fleet-wide run-all (T396): POST /api/workflows/run-all fires a manual run of
// every workflow, skipping ones already running (best-effort, not all-or-nothing),
// defaulting limitable workflows to `limit` (3) and running non-limitable ones
// unlimited. Self-contained fixtures: one limitable workflow, one plain one, and
// one seeded as already-running (cleaned up afterwards). ──
{
  const raLimRoot: JobDefinition = { name: 'ra-lim-root', inputKeys: () => ['a', 'b'], run: async () => {} };
  const raPlain: JobDefinition = { name: 'ra-plain', run: async () => {} };
  const raBusyJob: JobDefinition = { name: 'ra-busy-job', run: async () => {} };
  for (const d of [raLimRoot, raPlain, raBusyJob]) { syncJob(d); jobs.push(d); }
  const raLimWf: WorkflowDefinition = { name: 'ra-lim-wf', jobs: [{ job: 'ra-lim-root' }] };
  const raPlainWf: WorkflowDefinition = { name: 'ra-plain-wf', jobs: [{ job: 'ra-plain' }] };
  const raBusyWf: WorkflowDefinition = { name: 'ra-busy-wf', jobs: [{ job: 'ra-busy-job' }] };
  for (const w of [raLimWf, raPlainWf, raBusyWf]) { syncWorkflow(w); workflows.push(w); }

  await test('run-all: skips already-running workflows, resolves limit for limitable ones, runs non-limitable ones unlimited', async () => {
    const wrid = createWorkflowRun('ra-busy-wf', 'manual'); // status 'running'
    try {
      await withServer({}, async (base) => {
        const res = await fetch(`${base}/api/workflows/run-all`, { method: 'POST' });
        assert.equal(res.status, 202);
        const body = (await res.json()) as {
          ok: boolean;
          totalWorkflows: number;
          startedCount: number;
          skippedCount: number;
          limit: number;
          results: Array<
            | { name: string; status: 'started'; limited: boolean; limit: number | null }
            | { name: string; status: 'skipped'; reason: string }
          >;
        };
        assert.equal(body.ok, true);
        assert.equal(body.limit, 3, 'defaults to limit 3 when omitted');
        assert.ok(body.results.length >= 3, 'at least the 3 seeded fixture workflows are present');

        const busy = body.results.find((r) => r.name === 'ra-busy-wf');
        assert.ok(busy, 'busy workflow present in results');
        assert.equal(busy!.status, 'skipped');
        assert.equal((busy as { reason?: string }).reason, 'already running');

        const lim = body.results.find((r) => r.name === 'ra-lim-wf');
        assert.ok(lim, 'limitable workflow present in results');
        assert.equal(lim!.status, 'started');
        assert.equal((lim as { limited?: boolean }).limited, true);
        assert.equal((lim as { limit?: number | null }).limit, 3);

        const plain = body.results.find((r) => r.name === 'ra-plain-wf');
        assert.ok(plain, 'non-limitable workflow present in results');
        assert.equal(plain!.status, 'started');
        assert.equal((plain as { limited?: boolean }).limited, false);
        assert.equal((plain as { limit?: number | null }).limit, null);

        assert.equal(body.startedCount, body.results.filter((r) => r.status === 'started').length);
        assert.equal(body.skippedCount, body.results.filter((r) => r.status === 'skipped').length);
        assert.equal(body.totalWorkflows, body.results.length);
      });
    } finally {
      finishWorkflowRun(wrid, 'cancelled'); // release the active run for other tests
    }
  });

  await test('run-all: rejects a non-positive/non-integer limit with 400', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/run-all`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: -1 }),
      });
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error?: string }).error ?? '', /limit must be a positive integer/);
    });
  });

  for (const d of [raLimRoot, raPlain, raBusyJob]) { const i = jobs.indexOf(d); if (i >= 0) jobs.splice(i, 1); }
  for (const w of [raLimWf, raPlainWf, raBusyWf]) { const i = workflows.indexOf(w); if (i >= 0) workflows.splice(i, 1); }
}

// ── definition-level gate detail (T102): the run-AGNOSTIC
// GET /api/workflows/:name/gates/:producer/:key returns the structural gate
// (key, enriched description, producer→consumer) plus each side's declared
// expected shape — no run state, no actuals, no contract check() runs. A fake
// two-stage workflow with a producer→consumer artifact contract, registered then
// cleaned up. ──
{
  const shapeA: ArtifactShape = {
    summary: 'rows of stuff', format: 'csv',
    expectations: [{ label: 'non-empty', detail: 'has at least one row' }],
  };
  let checkCalls = 0;
  const upstream: JobDefinition = {
    name: 'gate-up', run: async () => {},
    produces: [{ key: 'artA', description: 'the A artifact', shape: shapeA, check: () => { checkCalls++; return { ok: true }; } }],
  };
  const downstream: JobDefinition = {
    name: 'gate-down', run: async () => {},
    consumes: [{ key: 'artA', description: 'needs A', shape: { summary: 'consumes A', expectations: [{ label: 'parseable' }] }, check: () => { checkCalls++; return { ok: true }; } }],
  };
  for (const d of [upstream, downstream]) { syncJob(d); jobs.push(d); }
  const gw: WorkflowDefinition = { name: 'gate-wf', jobs: [{ job: 'gate-up' }, { job: 'gate-down', dependsOn: ['gate-up'] }] };
  syncWorkflow(gw); workflows.push(gw);

  await test('definition gate: endpoint returns structural gate + both sides expected shape, never runs check()', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/gate-wf/gates/gate-up/artA`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        gate: { producer: string; consumer: string; key: string; description?: string };
        produced: { shape: ArtifactShape | null };
        consumed: { shape: ArtifactShape | null };
        identical: boolean;
      };
      assert.equal(body.gate.producer, 'gate-up');
      assert.equal(body.gate.consumer, 'gate-down');
      assert.equal(body.gate.key, 'artA');
      assert.match(body.gate.description ?? '', /the A artifact/);
      assert.equal(body.produced.shape?.summary, 'rows of stuff');
      assert.equal(body.consumed.shape?.summary, 'consumes A');
      // This gate is ASYMMETRIC (produces shape ≠ consumes shape) → not collapsible.
      assert.equal(body.identical, false, 'differing shapes must report identical:false');
      assert.equal(checkCalls, 0, 'definition-level endpoint must NOT run any contract check()');
    });
  });

  await test('definition gate: unknown gate 404s; unknown workflow 404s', async () => {
    await withServer({}, async (base) => {
      assert.equal((await fetch(`${base}/api/workflows/gate-wf/gates/gate-up/nope`)).status, 404);
      assert.equal((await fetch(`${base}/api/workflows/__no_such__/gates/gate-up/artA`)).status, 404);
    });
  });

  for (const d of [upstream, downstream]) { const i = jobs.indexOf(d); if (i >= 0) jobs.splice(i, 1); }
  { const i = workflows.indexOf(gw); if (i >= 0) workflows.splice(i, 1); }
}

// ── T138: the gate inspection endpoints report `identical` so the detail page can
// collapse the duplicated producer/consumer panels when both sides declare the
// SAME shape (the normal one-factory-per-key case). Asymmetric is covered above. ──
{
  const sharedShape: ArtifactShape = {
    summary: 'the shared artifact', format: 'json file',
    expectations: [{ label: 'non-empty', detail: 'at least one entry' }],
  };
  const idProd: JobDefinition = {
    name: 'id-prod', run: async () => {},
    produces: [{ key: 'shared', description: 'emits shared', shape: sharedShape, check: () => ({ ok: true, sample: '3 entries' }) }],
  };
  const idCons: JobDefinition = {
    name: 'id-cons', run: async () => {},
    // A SEPARATE but DEEP-EQUAL shape value on the consume side — the one-factory
    // case after JSON round-trips; `identical` is a structural compare, not ===.
    consumes: [{ key: 'shared', description: 'needs shared', shape: { summary: 'the shared artifact', format: 'json file', expectations: [{ label: 'non-empty', detail: 'at least one entry' }] }, check: () => ({ ok: true }) }],
  };
  for (const d of [idProd, idCons]) { syncJob(d); jobs.push(d); }
  const idWf: WorkflowDefinition = { name: 'identical-wf', jobs: [{ job: 'id-prod' }, { job: 'id-cons', dependsOn: ['id-prod'] }] };
  syncWorkflow(idWf); workflows.push(idWf);
  const idRunId = createWorkflowRun('identical-wf', 'manual');

  await test('definition gate: identical:true when both sides declare the same shape (collapsible)', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/identical-wf/gates/id-prod/shared`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { identical: boolean; produced: { shape: ArtifactShape | null }; consumed: { shape: ArtifactShape | null } };
      assert.equal(body.identical, true);
      assert.ok(body.produced.shape && body.consumed.shape, 'both sides still returned (page chooses how to render)');
    });
  });

  await test('run-scoped gate: identical:true with both sides still present (page collapses)', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflow-runs/${idRunId}/gates/id-prod/shared`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { identical: boolean; produced: unknown; consumed: unknown };
      assert.equal(body.identical, true);
      assert.ok(body.produced && body.consumed, 'both sides still returned even when collapsible');
    });
  });

  for (const d of [idProd, idCons]) { const i = jobs.indexOf(d); if (i >= 0) jobs.splice(i, 1); }
  { const i = workflows.indexOf(idWf); if (i >= 0) workflows.splice(i, 1); }
}

// ── T110: workflow-run output preview / path-safety ──
await test('isWithin: nesting yes; siblings / traversal / absolute escapes no', () => {
  assert.equal(isWithin('/a/b', '/a/b'), true);
  assert.equal(isWithin('/a/b', '/a/b/c/d.md'), true);
  assert.equal(isWithin('/a/b', '/a/c/d.md'), false);
  assert.equal(isWithin('/a/b', '/a/b/../c'), false);
  assert.equal(isWithin('/a/b', '/etc/passwd'), false);
});

{
  // A real .md under a job's data/out tree (the only place reads are allowed).
  const workflowsRoot = fileURLToPath(new URL('../workflows', import.meta.url));
  const outDir = `${workflowsRoot}/perfumes/data/out/markdown`;
  const okFile = `${outDir}/__t110-test__.md`;
  const wrongDir = `${workflowsRoot}/perfumes/data/raw/__t110-test__.md`; // not under data/out
  const txtFile = `${outDir}/__t110-test__.txt`; // not markdown
  mkdirSync(outDir, { recursive: true });
  mkdirSync(`${workflowsRoot}/perfumes/data/raw`, { recursive: true });
  writeFileSync(okFile, '# Hi\n');
  writeFileSync(wrongDir, '# Hi\n');
  writeFileSync(txtFile, 'hi\n');

  await test('safeOutputMarkdown: accepts a real .md inside a job data/out tree', () => {
    assert.ok(safeOutputMarkdown(okFile), 'a real .md under data/out is allowed');
  });
  await test('safeOutputMarkdown: rejects null / traversal / outside / non-md / missing', () => {
    assert.equal(safeOutputMarkdown(null), null, 'null');
    assert.equal(safeOutputMarkdown('/etc/passwd'), null, 'outside the workflows tree');
    assert.equal(safeOutputMarkdown(`${outDir}/../../../../../../etc/passwd`), null, 'traversal escapes');
    assert.equal(safeOutputMarkdown(wrongDir), null, 'not under data/out');
    assert.equal(safeOutputMarkdown(txtFile), null, 'not a .md file');
    assert.equal(safeOutputMarkdown(`${outDir}/__does_not_exist__.md`), null, 'missing file');
  });
  await test('safeOutputMarkdown: accepts a workflows-root-relative candidate (T447 storage format)', () => {
    assert.ok(
      safeOutputMarkdown('perfumes/data/out/markdown/__t110-test__.md'),
      'a relative path resolved against WORKFLOWS_ROOT is allowed, same as the equivalent absolute path',
    );
  });

  // End-to-end: a run + a work item carrying detail.markdown → endpoint serves it.
  syncJob({ name: 't110-in', run: async () => {} });
  syncJob({ name: 't110-out', run: async () => {} });
  syncWorkflow({ name: 't110-wf', jobs: [{ job: 't110-in' }, { job: 't110-out', dependsOn: ['t110-in'] }] });
  markWorkItem('t110-out', 'item-1', 'success', { detail: { name: 'Sample', markdown: okFile } });
  markWorkItem('t110-out', 'item-noart', 'success', { detail: { name: 'NoFile', markdown: '/etc/passwd' } });
  const runId = createWorkflowRun('t110-wf', 'manual');

  await test('output endpoint: serves the produced markdown for a work item', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflow-runs/${runId}/output?job=t110-out&key=item-1`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { found: boolean; content?: string; file?: string };
      assert.equal(body.found, true);
      assert.equal(body.content, '# Hi\n');
      assert.match(body.file ?? '', /perfumes\/data\/out\/markdown\/__t110-test__\.md$/);
    });
  });
  await test('output endpoint: found:false for an unsafe / missing artifact (never serves it)', async () => {
    await withServer({}, async (base) => {
      const r1 = await fetch(`${base}/api/workflow-runs/${runId}/output?job=t110-out&key=item-noart`);
      assert.equal(r1.status, 200);
      assert.equal(((await r1.json()) as { found: boolean }).found, false, 'an outside path is never served');
      const r2 = await fetch(`${base}/api/workflow-runs/${runId}/output?job=t110-out&key=nope`);
      assert.equal(((await r2.json()) as { found: boolean }).found, false, 'an item with no artifact');
    });
  });
  await test('output endpoint: 400 without job/key; 404 for an unknown run', async () => {
    await withServer({}, async (base) => {
      assert.equal((await fetch(`${base}/api/workflow-runs/${runId}/output`)).status, 400);
      assert.equal((await fetch(`${base}/api/workflow-runs/__no_run__/output?job=t110-out&key=item-1`)).status, 404);
    });
  });

  finishWorkflowRun(runId, 'success');
  rmSync(okFile, { force: true });
  rmSync(wrongDir, { force: true });
  rmSync(txtFile, { force: true });
}

// ── T262: declared output form — safeOutputFile + non-markdown endpoint dispatch ──
{
  const workflowsRoot = fileURLToPath(new URL('../workflows', import.meta.url));
  const outDir = `${workflowsRoot}/perfumes/data/out/reports`;
  const jsonFile = `${outDir}/__t262-test__.json`;
  const outsideFile = `${workflowsRoot}/perfumes/data/raw/__t262-outside__.json`; // not under data/out
  mkdirSync(outDir, { recursive: true });
  mkdirSync(`${workflowsRoot}/perfumes/data/raw`, { recursive: true });
  writeFileSync(jsonFile, '{"ok":true}\n');
  writeFileSync(outsideFile, '{"bad":true}\n');

  await test('safeOutputFile: accepts any file type inside a job data/out tree', () => {
    assert.ok(safeOutputFile(jsonFile), 'a json file under data/out is allowed');
  });
  await test('safeOutputFile: rejects null / traversal / outside / missing', () => {
    assert.equal(safeOutputFile(null), null, 'null');
    assert.equal(safeOutputFile('/etc/passwd'), null, 'outside the workflows tree');
    assert.equal(safeOutputFile(`${outDir}/../../../../../../etc/passwd`), null, 'traversal escapes');
    assert.equal(safeOutputFile(outsideFile), null, 'not under data/out');
    assert.equal(safeOutputFile(`${outDir}/__no_such_file__.json`), null, 'missing file');
  });
  await test('safeOutputFile: accepts a workflows-root-relative candidate (T447 storage format)', () => {
    assert.ok(
      safeOutputFile('perfumes/data/out/reports/__t262-test__.json'),
      'a relative path resolved against WORKFLOWS_ROOT is allowed, same as the equivalent absolute path',
    );
  });

  // Workflow output endpoint: markdown form (backward compat) vs declared non-markdown form
  syncJob({ name: 't262-out', run: async () => {} });
  syncWorkflow({ name: 't262-wf', jobs: [{ job: 't262-out' }] });
  // Markdown item (existing convention — detail.markdown, no detail.format)
  const mdFile = `${workflowsRoot}/perfumes/data/out/markdown/__t262-md__.md`;
  mkdirSync(`${workflowsRoot}/perfumes/data/out/markdown`, { recursive: true });
  writeFileSync(mdFile, '# T262\n');
  markWorkItem('t262-out', 'md-item', 'success', { detail: { name: 'MdItem', markdown: mdFile } });
  // Non-markdown item (detail.format + detail.path)
  markWorkItem('t262-out', 'json-item', 'success', { detail: { name: 'JsonItem', format: 'json', path: jsonFile } });
  // Path-unsafe item (detail.format + unsafe detail.path)
  markWorkItem('t262-out', 'unsafe-item', 'success', { detail: { name: 'Unsafe', format: 'json', path: outsideFile } });
  const t262RunId = createWorkflowRun('t262-wf', 'manual');

  await test('output endpoint: serves markdown form byte-identically (backward compat)', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflow-runs/${t262RunId}/output?job=t262-out&key=md-item`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { found: boolean; format?: string; content?: string };
      assert.equal(body.found, true);
      assert.equal(body.format, 'markdown');
      assert.equal(body.content, '# T262\n');
    });
  });
  await test('output endpoint: serves declared non-markdown form via safeOutputFile', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflow-runs/${t262RunId}/output?job=t262-out&key=json-item`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { found: boolean; format?: string; content?: string };
      assert.equal(body.found, true);
      assert.equal(body.format, 'json');
      assert.equal(body.content, '{"ok":true}\n');
    });
  });
  await test('output endpoint: path-safety guard blocks unsafe declared path (found:false)', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflow-runs/${t262RunId}/output?job=t262-out&key=unsafe-item`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { found: boolean; format?: string };
      assert.equal(body.found, false);
      assert.equal(body.format, 'json');
    });
  });

  finishWorkflowRun(t262RunId, 'success');
  rmSync(jsonFile, { force: true });
  rmSync(outsideFile, { force: true });
  rmSync(mdFile, { force: true });
}

// ── T118: bulk stuck endpoints — scope validation + only-failed semantics ──
{
  syncJob({ name: 'bulk-api-j1', run: async () => {} });
  syncJob({ name: 'bulk-api-j2', run: async () => {} });
  syncWorkflow({ name: 'bulk-api-wf', description: 'd', schedule: null, jobs: [{ job: 'bulk-api-j1' }, { job: 'bulk-api-j2' }] });
  jobs.push({ name: 'bulk-api-j1', run: async () => {} });
  jobs.push({ name: 'bulk-api-j2', run: async () => {} });
  workflows.push({ name: 'bulk-api-wf', description: 'd', schedule: null, jobs: [{ job: 'bulk-api-j1' }, { job: 'bulk-api-j2' }] });

  await test('bulk unstick-bulk: all scope removes all failed rows', async () => {
    markWorkItem('bulk-api-j1', 'bapi-f1', 'failed', { attempts: 4 });
    markWorkItem('bulk-api-j2', 'bapi-f2', 'failed', { attempts: 4 });
    markWorkItem('bulk-api-j1', 'bapi-ok', 'success');
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/stuck/unstick-bulk`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; unstuck: number };
      assert.equal(body.ok, true);
      assert.ok(body.unstuck >= 2, `expected ≥2 unstuck, got ${body.unstuck}`);
    });
  });

  await test('bulk ignore-bulk: job scope only ignores that job\'s failed rows', async () => {
    markWorkItem('bulk-api-j1', 'bapi-ig1', 'failed', { attempts: 4 });
    markWorkItem('bulk-api-j2', 'bapi-ig2', 'failed', { attempts: 4 });
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/stuck/ignore-bulk`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'job', job: 'bulk-api-j1' }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; ignored: number };
      assert.equal(body.ok, true);
      assert.equal(body.ignored, 1, 'only the job-scoped row was ignored');
    });
  });

  await test('bulk ignore-bulk: workflow scope only ignores member jobs', async () => {
    markWorkItem('bulk-api-j1', 'bapi-wf1', 'failed', { attempts: 4 });
    markWorkItem('bulk-api-j2', 'bapi-wf2', 'failed', { attempts: 4 });
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/stuck/ignore-bulk`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'workflow', workflow: 'bulk-api-wf' }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; ignored: number };
      assert.equal(body.ok, true);
      assert.ok(body.ignored >= 2, `workflow scope should ignore both member jobs' rows`);
    });
  });

  await test('bulk ignore-bulk: unknown workflow returns 400', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/stuck/ignore-bulk`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'workflow', workflow: '__no_such_wf__' }),
      });
      assert.equal(res.status, 400);
    });
  });

  // Cleanup registry entries
  for (const name of ['bulk-api-j1', 'bulk-api-j2']) {
    const i = jobs.findIndex((j) => j.name === name); if (i >= 0) jobs.splice(i, 1);
  }
  { const i = workflows.findIndex((w) => w.name === 'bulk-api-wf'); if (i >= 0) workflows.splice(i, 1); }
}

// ── GET /api/logs (T311) ──
{
  await test('GET /api/logs: job and workflow filters together return 400', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/logs?job=foo&workflow=bar`);
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /mutually exclusive/);
    });
  });

  await test('GET /api/logs: invalid level returns 400', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/logs?level=bogus`);
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /invalid level/);
    });
  });

  await test('GET /api/logs: limit is clamped into [1, 500], not rejected', async () => {
    await withServer({}, async (base) => {
      const tooBig = await fetch(`${base}/api/logs?limit=99999`);
      assert.equal(tooBig.status, 200);
      const bodyBig = (await tooBig.json()) as { logs: unknown[] };
      assert.ok(bodyBig.logs.length <= 500);

      const tooSmall = await fetch(`${base}/api/logs?limit=0`);
      assert.equal(tooSmall.status, 200);
    });
  });

  await test('GET /api/logs: default call returns a { logs, nextCursor } shape', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/logs`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { logs: unknown[]; nextCursor: string | null };
      assert.ok(Array.isArray(body.logs));
      assert.ok(body.nextCursor === null || typeof body.nextCursor === 'string');
    });
  });
}

// ── GET /api/workflow-runs/:id/stage-io — decoupled inputs/outputs, no
// root_key collapsing (added for stock-digest's many-to-one aggregation stage).
{
  syncJob({ name: 'sio-api-a', run: async () => {} });
  syncJob({ name: 'sio-api-b', run: async () => {} });
  syncJob({ name: 'sio-api-c', run: async () => {} });
  syncWorkflow({
    name: 'sio-api-wf',
    jobs: [
      { job: 'sio-api-a' },
      { job: 'sio-api-b', dependsOn: ['sio-api-a'] },
      { job: 'sio-api-c', dependsOn: ['sio-api-a', 'sio-api-b'] },
    ],
  });

  const sioRun = createWorkflowRun('sio-api-wf', 'manual');
  markWorkItem('sio-api-a', 'week-1', 'success', { workflowRunId: sioRun, detail: { name: 'Snapshot' } });
  markWorkItem('sio-api-b', 'X', 'success', { rootKey: 'week-1', workflowRunId: sioRun });
  markWorkItem('sio-api-b', 'Y', 'success', { rootKey: 'week-1', workflowRunId: sioRun });
  markWorkItem('sio-api-b', 'Z', 'failed', { rootKey: 'week-1', workflowRunId: sioRun });
  markWorkItem('sio-api-c', 'week-1', 'success', { rootKey: 'week-1', workflowRunId: sioRun });

  await test('GET /api/workflow-runs/:id/stage-io — root stage has no inputs', async () => {
    await withServer({}, async (base) => {
      const body = (await (await fetch(`${base}/api/workflow-runs/${sioRun}/stage-io?job=sio-api-a`)).json()) as {
        inputs: unknown[]; outputs: { itemKey: string }[]; predecessorJobs: string[]; job: string;
      };
      assert.equal(body.job, 'sio-api-a');
      assert.deepEqual(body.predecessorJobs, []);
      assert.equal(body.inputs.length, 0);
      assert.deepEqual(body.outputs.map((o) => o.itemKey), ['week-1']);
    });
  });

  await test('GET /api/workflow-runs/:id/stage-io — fan-out stage shows ALL its rows, not collapsed', async () => {
    await withServer({}, async (base) => {
      const body = (await (await fetch(`${base}/api/workflow-runs/${sioRun}/stage-io?job=sio-api-b`)).json()) as {
        inputs: { itemKey: string }[]; outputs: { itemKey: string; status: string }[];
      };
      assert.deepEqual(body.inputs.map((i) => i.itemKey), ['week-1']);
      assert.deepEqual(body.outputs.map((o) => o.itemKey).sort(), ['X', 'Y', 'Z'], 'all 3 rows, no root_key collapsing');
    });
  });

  await test('GET /api/workflow-runs/:id/stage-io — fan-in stage inputs union BOTH predecessors', async () => {
    await withServer({}, async (base) => {
      const body = (await (await fetch(`${base}/api/workflow-runs/${sioRun}/stage-io?job=sio-api-c`)).json()) as {
        inputs: { jobName: string; itemKey: string }[]; outputs: { itemKey: string }[]; predecessorJobs: string[];
      };
      assert.deepEqual(body.predecessorJobs.sort(), ['sio-api-a', 'sio-api-b']);
      assert.equal(body.inputs.length, 4, 'sio-api-a\'s 1 row + sio-api-b\'s 3 rows');
      assert.deepEqual(body.outputs.map((o) => o.itemKey), ['week-1']);
    });
  });

  await test('GET /api/workflow-runs/:id/stage-io — no ?job -> 400', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflow-runs/${sioRun}/stage-io`);
      assert.equal(res.status, 400);
    });
  });

  await test('GET /api/workflow-runs/:id/stage-io — unknown job -> 400', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflow-runs/${sioRun}/stage-io?job=not-a-real-job`);
      assert.equal(res.status, 400);
    });
  });

  // T383: stageIoLists() gained a multi-job outputJobNames signature — pin that the
  // single-job endpoint call site (still passing `[jobParam]`) returns the EXACT same
  // shape/values as before that change.
  await test('GET /api/workflow-runs/:id/stage-io — single-job shape unchanged after T383 signature change', async () => {
    await withServer({}, async (base) => {
      const body = (await (await fetch(`${base}/api/workflow-runs/${sioRun}/stage-io?job=sio-api-b`)).json()) as {
        inputs: { jobName: string; itemKey: string; status: string }[];
        outputs: { jobName: string; itemKey: string; status: string }[];
        predecessorJobs: string[];
        job: string;
      };
      assert.equal(body.job, 'sio-api-b');
      assert.deepEqual(body.predecessorJobs, ['sio-api-a']);
      assert.equal(body.inputs.length, 1);
      assert.equal(body.inputs[0].jobName, 'sio-api-a');
      assert.equal(body.inputs[0].itemKey, 'week-1');
      assert.equal(body.outputs.length, 3);
      assert.deepEqual(body.outputs.map((o) => o.jobName), ['sio-api-b', 'sio-api-b', 'sio-api-b']);
      assert.deepEqual(body.outputs.map((o) => o.itemKey).sort(), ['X', 'Y', 'Z']);
      assert.deepEqual(body.outputs.map((o) => o.status).sort(), ['failed', 'success', 'success']);
    });
  });

  // T384: overall=true — the workflow's OWN root/idempotency keys as inputs,
  // its EFFECTIVE terminal stage(s) as outputs.
  await test('GET /api/workflow-runs/:id/stage-io?overall=true — inputs match the DAG root wave for a fan-in workflow', async () => {
    await withServer({}, async (base) => {
      const body = (await (await fetch(`${base}/api/workflow-runs/${sioRun}/stage-io?overall=true`)).json()) as {
        inputs: { jobName: string; itemKey: string }[];
        outputs: { jobName: string; itemKey: string }[];
        predecessorJobs: string[];
        outputJobs: string[];
        job: string;
      };
      assert.equal(body.job, '__overall__');
      assert.deepEqual(body.predecessorJobs, ['sio-api-a']);
      assert.deepEqual(body.outputJobs, ['sio-api-c']);
      assert.equal(body.inputs.length, 1, 'root wave (sio-api-a) has one ledger row this run');
      assert.equal(body.inputs[0].jobName, 'sio-api-a');
      assert.equal(body.inputs[0].itemKey, 'week-1');
      assert.equal(body.outputs.length, 1, 'terminal wave (sio-api-c) has one ledger row this run');
      assert.equal(body.outputs[0].jobName, 'sio-api-c');
      assert.equal(body.outputs[0].itemKey, 'week-1');
    });
  });
}

// ── T384: overall=true honors a workflow's outputJob override (mirrors T348's
// stocks-sync-style pattern: the true DAG terminal stage records nothing, an
// earlier outputJob-named stage carries the real ledger rows). ──
{
  syncJob({ name: 't384-first', run: async () => {} });
  syncJob({ name: 't384-last', run: async () => {} });
  jobs.push({ name: 't384-first', run: async () => {} }, { name: 't384-last', run: async () => {} });
  const t384OverrideWf = {
    name: 't384-override-wf',
    jobs: [{ job: 't384-first' }, { job: 't384-last', dependsOn: ['t384-first'] }],
    outputJob: 't384-first',
  };
  syncWorkflow(t384OverrideWf);
  workflows.push(t384OverrideWf);

  const t384Run = createWorkflowRun('t384-override-wf', 'manual');
  markWorkItem('t384-first', 'pos-1', 'success', { workflowRunId: t384Run });
  // t384-last (the raw DAG last wave / true terminal) never records anything —
  // mirrors stocks-notify.

  await test('GET /api/workflow-runs/:id/stage-io?overall=true — outputs reflect the outputJob override, not the empty raw last wave', async () => {
    await withServer({}, async (base) => {
      const body = (await (await fetch(`${base}/api/workflow-runs/${t384Run}/stage-io?overall=true`)).json()) as {
        inputs: unknown[];
        outputs: { jobName: string; itemKey: string }[];
        predecessorJobs: string[];
        outputJobs: string[];
        job: string;
      };
      assert.equal(body.job, '__overall__');
      assert.deepEqual(body.outputJobs, ['t384-first'], 'outputJob override, not the raw terminal wave [t384-last]');
      // T448: the root wave IS the outputJob override here, so there is no genuine
      // distinct predecessor to show — inputs must be filtered out, not duplicated.
      assert.deepEqual(body.predecessorJobs, [], 'root wave equals outputJobs -> no distinct predecessor');
      assert.equal(body.inputs.length, 0, 'no duplicated input row when input job == output job');
      assert.equal(body.outputs.length, 1);
      assert.equal(body.outputs[0].jobName, 't384-first');
      assert.equal(body.outputs[0].itemKey, 'pos-1');
    });
  });

  // T448: a genuinely single-wave workflow (every job independent, no dependsOn
  // edges — e.g. plex-space-saver/claude-warmer/listening-digest in production)
  // must show an EMPTY inputs list on the Overall tab, not a duplicate of outputs.
  syncJob({ name: 't448-solo', run: async () => {} });
  syncWorkflow({ name: 't448-solo-wf', jobs: [{ job: 't448-solo' }] });
  const t448SoloRun = createWorkflowRun('t448-solo-wf', 'manual');
  markWorkItem('t448-solo', 'week-1', 'success', {
    workflowRunId: t448SoloRun,
    detail: { name: 'Size breakdown', markdown: '/tmp/does-not-matter.md' },
  });

  await test('GET /api/workflow-runs/:id/stage-io?overall=true — single-wave workflow shows EMPTY inputs, not a duplicate of outputs (T448)', async () => {
    await withServer({}, async (base) => {
      const body = (await (await fetch(`${base}/api/workflow-runs/${t448SoloRun}/stage-io?overall=true`)).json()) as {
        inputs: unknown[];
        outputs: { jobName: string; itemKey: string }[];
        predecessorJobs: string[];
        outputJobs: string[];
        job: string;
      };
      assert.equal(body.job, '__overall__');
      assert.deepEqual(body.outputJobs, ['t448-solo']);
      assert.deepEqual(body.predecessorJobs, [], 'single-wave workflow -> no distinct input job');
      assert.equal(body.inputs.length, 0, 'inputs must be empty, not a duplicate of the output row');
      assert.equal(body.outputs.length, 1);
      assert.equal(body.outputs[0].jobName, 't448-solo');
      assert.equal(body.outputs[0].itemKey, 'week-1');
    });
  });

  // Cleanup registry stubs.
  for (const n of ['t384-first', 't384-last']) {
    const i = jobs.findIndex((x) => x.name === n); if (i >= 0) jobs.splice(i, 1);
  }
  { const i = workflows.findIndex((x) => x.name === 't384-override-wf'); if (i >= 0) workflows.splice(i, 1); }
}

// ── movie-gaps endpoints (T145): GET overlays ignored/notified; POST ignores ──
{
  const { moviesConfig } = await import('../workflows/movies/config.js');
  const { NOTIFY_JOB, gapKey } = await import('../workflows/movies/stages/notify.js');
  const { markWorkItem: mark, ignoredItemKeys: ignoredKeys } = await import('../db/store.js');

  // Distinct synthetic tmdbIds; back up + restore the real gaps file so a dev box's
  // audit output is never clobbered.
  const NOTIFIED = 9970001;
  const FRESH = 9970002;
  const TO_IGNORE = 9970003;
  const gapsPath = moviesConfig.gapsOut;
  const hadFile = existsSync(gapsPath);
  const backup = hadFile ? readFileSync(gapsPath, 'utf8') : null;
  // T468: `moviesConfig.gapsOut` is now an alias into the separate `missing-movies`
  // workflow's own data dir, NOT `moviesConfig.outDir` — mkdir the gaps file's OWN
  // parent, not the (now unrelated) movies outDir, or this throws ENOENT on a
  // fresh checkout with no data/ dirs at all (CI never has them; a dev box can
  // mask this if an earlier run already created the directory).
  mkdirSync(dirname(gapsPath), { recursive: true });
  writeFileSync(gapsPath, JSON.stringify({
    generatedAt: '2026-06-01T00:00:00Z',
    collectionsChecked: 2,
    gaps: [
      { collectionId: 1, collectionName: 'A', tmdbId: NOTIFIED, title: 'Already Notified', year: 2020, tmdbRating: 7 },
      { collectionId: 1, collectionName: 'A', tmdbId: FRESH, title: 'Fresh', year: 2021, tmdbRating: 6 },
      { collectionId: 2, collectionName: 'B', tmdbId: TO_IGNORE, title: 'To Ignore', year: 2022, tmdbRating: 5 },
    ],
  }));
  mark(NOTIFY_JOB, gapKey(NOTIFIED), 'success'); // pretend it was already digested

  try {
    await test('GET /api/movie-gaps overlays notified + ignored status', async () => {
      await withServer({}, async (base) => {
        const data = (await (await fetch(`${base}/api/movie-gaps`)).json()) as {
          gaps: { tmdbId: number; notified: boolean; ignored: boolean }[];
        };
        const byId = new Map(data.gaps.map((g) => [g.tmdbId, g]));
        assert.equal(byId.get(NOTIFIED)?.notified, true, 'already-digested gap is flagged notified');
        assert.equal(byId.get(FRESH)?.notified, false, 'a fresh gap is not yet notified');
        assert.equal(byId.get(FRESH)?.ignored, false);
      });
    });

    await test('POST /api/movie-gaps/:id/ignore suppresses a gap (manual ignore)', async () => {
      await withServer({}, async (base) => {
        const res = await fetch(`${base}/api/movie-gaps/${TO_IGNORE}/ignore`, { method: 'POST' });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { ok: boolean; ignored: number };
        assert.equal(body.ok, true);
        assert.ok(body.ignored >= 1);
        assert.ok(ignoredKeys(NOTIFY_JOB).has(gapKey(TO_IGNORE)), 'ledger row is now ignored');

        const data = (await (await fetch(`${base}/api/movie-gaps`)).json()) as {
          gaps: { tmdbId: number; ignored: boolean }[];
        };
        assert.equal(data.gaps.find((g) => g.tmdbId === TO_IGNORE)?.ignored, true, 'GET reflects the ignore');
      });
    });

    await test('POST /api/movie-gaps/:id/ignore rejects a non-numeric id (400)', async () => {
      await withServer({}, async (base) => {
        const res = await fetch(`${base}/api/movie-gaps/not-a-number/ignore`, { method: 'POST' });
        assert.equal(res.status, 400);
      });
    });

    await test('POST /api/movie-gaps/:id/unignore reverses a manual ignore (T391)', async () => {
      await withServer({}, async (base) => {
        const ignoreRes = await fetch(`${base}/api/movie-gaps/${TO_IGNORE}/ignore`, { method: 'POST' });
        assert.equal(ignoreRes.status, 200);
        assert.ok(ignoredKeys(NOTIFY_JOB).has(gapKey(TO_IGNORE)), 'ledger row is ignored');

        const res = await fetch(`${base}/api/movie-gaps/${TO_IGNORE}/unignore`, { method: 'POST' });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { ok: boolean; unignored: number };
        assert.equal(body.ok, true);
        assert.ok(body.unignored >= 1);
        assert.ok(!ignoredKeys(NOTIFY_JOB).has(gapKey(TO_IGNORE)), 'ledger row is no longer ignored');

        const data = (await (await fetch(`${base}/api/movie-gaps`)).json()) as {
          gaps: { tmdbId: number; ignored: boolean }[];
        };
        assert.equal(data.gaps.find((g) => g.tmdbId === TO_IGNORE)?.ignored, false, 'GET reflects the unignore');
      });
    });

    await test('POST /api/movie-gaps/:id/unignore rejects a non-numeric id (400)', async () => {
      await withServer({}, async (base) => {
        const res = await fetch(`${base}/api/movie-gaps/not-a-number/unignore`, { method: 'POST' });
        assert.equal(res.status, 400);
      });
    });

    await test('GET /api/movie-gaps returns collectionExamples from the gaps file', async () => {
      const examplesPath = gapsPath;
      writeFileSync(examplesPath, JSON.stringify({
        generatedAt: '2026-06-01T00:00:00Z',
        collectionsChecked: 2,
        gaps: [
          { collectionId: 1, collectionName: 'A', tmdbId: FRESH, title: 'Fresh', year: 2021, tmdbRating: 6 },
        ],
        collectionExamples: {
          A: { title: 'Owned Film', year: 2019 },
        },
      }));
      await withServer({}, async (base) => {
        const data = (await (await fetch(`${base}/api/movie-gaps`)).json()) as {
          collectionExamples: Record<string, { title: string; year: number | null }>;
        };
        assert.deepEqual(data.collectionExamples, { A: { title: 'Owned Film', year: 2019 } });
      });
    });

    await test('GET /api/movie-gaps returns empty collectionExamples when field absent', async () => {
      writeFileSync(gapsPath, JSON.stringify({
        generatedAt: '2026-06-01T00:00:00Z',
        collectionsChecked: 1,
        gaps: [],
      }));
      await withServer({}, async (base) => {
        const data = (await (await fetch(`${base}/api/movie-gaps`)).json()) as {
          collectionExamples: unknown;
        };
        assert.deepEqual(data.collectionExamples, {});
      });
    });
  } finally {
    if (backup !== null) writeFileSync(gapsPath, backup);
    else rmSync(gapsPath, { force: true });
  }
}

// ── movie-recs endpoints (T209): GET overlays ignored/notified; POST ignores ──
{
  const { moviesConfig } = await import('../workflows/movies/config.js');
  const { RECS_JOB, recKey } = await import('../workflows/movies/recs.js');
  const { markWorkItem: mark, ignoredItemKeys: ignoredKeys } = await import('../db/store.js');

  const NOTIFIED_REC = 9990001;
  const FRESH_REC    = 9990002;
  const IGNORE_REC   = 9990003;
  const recsPath = moviesConfig.recsOut;
  const hadFile = existsSync(recsPath);
  const backup = hadFile ? readFileSync(recsPath, 'utf8') : null;
  mkdirSync(moviesConfig.outDir, { recursive: true });
  const makeRec = (tmdbId: number, title: string) => ({
    tmdbId, title, year: 2020, reason: 'test', lens: 'test-lens', genre: 'Drama', tmdbRating: 7.5,
  });
  writeFileSync(recsPath, JSON.stringify({
    generatedAt: '2026-06-01T00:00:00Z',
    pooled: 30,
    recommendations: [
      makeRec(NOTIFIED_REC, 'Already Notified'),
      makeRec(FRESH_REC, 'Fresh Rec'),
      makeRec(IGNORE_REC, 'To Ignore'),
    ],
  }));
  mark(RECS_JOB, recKey(NOTIFIED_REC), 'success'); // pretend it was already digested

  try {
    await test('GET /api/movie-recs overlays notified + ignored status', async () => {
      await withServer({}, async (base) => {
        const data = (await (await fetch(`${base}/api/movie-recs`)).json()) as {
          recommendations: { tmdbId: number; notified: boolean; ignored: boolean }[];
        };
        const byId = new Map(data.recommendations.map((r) => [r.tmdbId, r]));
        assert.equal(byId.get(NOTIFIED_REC)?.notified, true, 'already-digested rec is flagged notified');
        assert.equal(byId.get(FRESH_REC)?.notified, false, 'fresh rec is not yet notified');
        assert.equal(byId.get(FRESH_REC)?.ignored, false);
      });
    });

    await test('POST /api/movie-recs/:id/ignore suppresses a rec (manual ignore)', async () => {
      await withServer({}, async (base) => {
        const res = await fetch(`${base}/api/movie-recs/${IGNORE_REC}/ignore`, { method: 'POST' });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { ok: boolean; ignored: number };
        assert.equal(body.ok, true);
        assert.ok(body.ignored >= 1);
        assert.ok(ignoredKeys(RECS_JOB).has(recKey(IGNORE_REC)), 'ledger row is now ignored');

        const data = (await (await fetch(`${base}/api/movie-recs`)).json()) as {
          recommendations: { tmdbId: number; ignored: boolean }[];
        };
        assert.equal(data.recommendations.find((r) => r.tmdbId === IGNORE_REC)?.ignored, true, 'GET reflects the ignore');
      });
    });

    await test('POST /api/movie-recs/:id/ignore rejects a non-numeric id (400)', async () => {
      await withServer({}, async (base) => {
        const res = await fetch(`${base}/api/movie-recs/not-a-number/ignore`, { method: 'POST' });
        assert.equal(res.status, 400);
      });
    });

    await test('GET /api/movie-recs returns empty list when file absent', async () => {
      rmSync(recsPath, { force: true });
      await withServer({}, async (base) => {
        const data = (await (await fetch(`${base}/api/movie-recs`)).json()) as {
          generatedAt: null; recommendations: unknown[];
        };
        assert.equal(data.generatedAt, null);
        assert.deepEqual(data.recommendations, []);
      });
    });

    await test('POST /api/movie-recs/ignore-bulk ignores multiple recs (T531)', async () => {
      const IDS_TO_IGNORE = [10550001, 10550002];
      await withServer({}, async (base) => {
        const res = await fetch(`${base}/api/movie-recs/ignore-bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tmdbIds: IDS_TO_IGNORE }),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { ok: boolean; ignored: number };
        assert.equal(body.ok, true);
        assert.equal(body.ignored, 2);

        const keys = ignoredKeys(RECS_JOB);
        for (const id of IDS_TO_IGNORE) {
          assert.ok(keys.has(recKey(id)), `rec ${id} is in ignored set`);
        }
      });
    });

    await test('POST /api/movie-recs/ignore-bulk rejects non-array or invalid ids (400)', async () => {
      await withServer({}, async (base) => {
        const res1 = await fetch(`${base}/api/movie-recs/ignore-bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tmdbIds: 'not-an-array' }),
        });
        assert.equal(res1.status, 400);

        const res2 = await fetch(`${base}/api/movie-recs/ignore-bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tmdbIds: [1, -1, 3] }),
        });
        assert.equal(res2.status, 400);
      });
    });

    await test('POST /api/movie-recs/unignore-bulk reverses a bulk ignore (T531)', async () => {
      const IDS_TO_RESTORE = [10550003, 10550004];
      await withServer({}, async (base) => {
        // First ignore them
        await fetch(`${base}/api/movie-recs/ignore-bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tmdbIds: IDS_TO_RESTORE }),
        });

        // Then unignore
        const res = await fetch(`${base}/api/movie-recs/unignore-bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tmdbIds: IDS_TO_RESTORE }),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { ok: boolean; unignored: number };
        assert.equal(body.ok, true);
        assert.equal(body.unignored, 2);

        const keys = ignoredKeys(RECS_JOB);
        for (const id of IDS_TO_RESTORE) {
          assert.equal(keys.has(recKey(id)), false, `rec ${id} is no longer ignored`);
        }
      });
    });
  } finally {
    if (backup !== null) writeFileSync(recsPath, backup);
    else rmSync(recsPath, { force: true });
  }
}

// ── tv-recs endpoints (T219): GET overlays ignored/notified; POST ignores ──
{
  const { tvRecsConfig } = await import('../workflows/tv-recs/config.js');
  const { RECS_JOB: TV_RECS_JOB, recKey: tvRecKey } = await import('../workflows/tv-recs/recs.js');
  const { markWorkItem: mark, ignoredItemKeys: ignoredKeys } = await import('../db/store.js');

  const NOTIFIED_REC = 9970001;
  const FRESH_REC    = 9970002;
  const IGNORE_REC   = 9970003;
  const recsPath = tvRecsConfig.recsOut;
  const hadFile = existsSync(recsPath);
  const backup = hadFile ? readFileSync(recsPath, 'utf8') : null;
  mkdirSync(tvRecsConfig.outDir, { recursive: true });
  const makeRec = (tmdbId: number, title: string) => ({
    tmdbId, title, year: 2022, reason: 'test', lens: 'test-lens', genre: 'Drama', tmdbRating: 8.0,
  });
  writeFileSync(recsPath, JSON.stringify({
    generatedAt: '2026-06-01T00:00:00Z',
    pooled: 20,
    recommendations: [
      makeRec(NOTIFIED_REC, 'Already Notified Show'),
      makeRec(FRESH_REC, 'Fresh Show'),
      makeRec(IGNORE_REC, 'Show To Ignore'),
    ],
  }));
  mark(TV_RECS_JOB, tvRecKey(NOTIFIED_REC), 'success'); // pretend it was already digested

  try {
    await test('GET /api/tv-recs overlays notified + ignored status', async () => {
      await withServer({}, async (base) => {
        const data = (await (await fetch(`${base}/api/tv-recs`)).json()) as {
          recommendations: { tmdbId: number; notified: boolean; ignored: boolean }[];
        };
        const byId = new Map(data.recommendations.map((r) => [r.tmdbId, r]));
        assert.equal(byId.get(NOTIFIED_REC)?.notified, true, 'already-digested rec is flagged notified');
        assert.equal(byId.get(FRESH_REC)?.notified, false, 'fresh rec is not yet notified');
        assert.equal(byId.get(FRESH_REC)?.ignored, false);
      });
    });

    await test('POST /api/tv-recs/:id/ignore suppresses a rec (manual ignore)', async () => {
      await withServer({}, async (base) => {
        const res = await fetch(`${base}/api/tv-recs/${IGNORE_REC}/ignore`, { method: 'POST' });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { ok: boolean; ignored: number };
        assert.equal(body.ok, true);
        assert.ok(body.ignored >= 1);
        assert.ok(ignoredKeys(TV_RECS_JOB).has(tvRecKey(IGNORE_REC)), 'ledger row is now ignored');

        const data = (await (await fetch(`${base}/api/tv-recs`)).json()) as {
          recommendations: { tmdbId: number; ignored: boolean }[];
        };
        assert.equal(data.recommendations.find((r) => r.tmdbId === IGNORE_REC)?.ignored, true, 'GET reflects the ignore');
      });
    });

    await test('POST /api/tv-recs/:id/ignore rejects a non-numeric id (400)', async () => {
      await withServer({}, async (base) => {
        const res = await fetch(`${base}/api/tv-recs/not-a-number/ignore`, { method: 'POST' });
        assert.equal(res.status, 400);
      });
    });

    await test('GET /api/tv-recs returns empty list when file absent', async () => {
      rmSync(recsPath, { force: true });
      await withServer({}, async (base) => {
        const data = (await (await fetch(`${base}/api/tv-recs`)).json()) as {
          generatedAt: null; recommendations: unknown[];
        };
        assert.equal(data.generatedAt, null);
        assert.deepEqual(data.recommendations, []);
      });
    });

    await test('POST /api/tv-recs/ignore-bulk ignores multiple TV recs (T531)', async () => {
      const IDS_TO_IGNORE = [10650001, 10650002];
      await withServer({}, async (base) => {
        const res = await fetch(`${base}/api/tv-recs/ignore-bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tmdbIds: IDS_TO_IGNORE }),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { ok: boolean; ignored: number };
        assert.equal(body.ok, true);
        assert.equal(body.ignored, 2);

        const keys = ignoredKeys(TV_RECS_JOB);
        for (const id of IDS_TO_IGNORE) {
          assert.ok(keys.has(tvRecKey(id)), `TV rec ${id} is in ignored set`);
        }
      });
    });

    await test('POST /api/tv-recs/ignore-bulk rejects non-array or invalid ids (400)', async () => {
      await withServer({}, async (base) => {
        const res1 = await fetch(`${base}/api/tv-recs/ignore-bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tmdbIds: 'not-an-array' }),
        });
        assert.equal(res1.status, 400);

        const res2 = await fetch(`${base}/api/tv-recs/ignore-bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tmdbIds: [1, 0, 3] }),
        });
        assert.equal(res2.status, 400);
      });
    });

    await test('POST /api/tv-recs/unignore-bulk reverses a bulk ignore (T531)', async () => {
      const IDS_TO_RESTORE = [10650003, 10650004];
      await withServer({}, async (base) => {
        // First ignore them
        await fetch(`${base}/api/tv-recs/ignore-bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tmdbIds: IDS_TO_RESTORE }),
        });

        // Then unignore
        const res = await fetch(`${base}/api/tv-recs/unignore-bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tmdbIds: IDS_TO_RESTORE }),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { ok: boolean; unignored: number };
        assert.equal(body.ok, true);
        assert.equal(body.unignored, 2);

        const keys = ignoredKeys(TV_RECS_JOB);
        for (const id of IDS_TO_RESTORE) {
          assert.equal(keys.has(tvRecKey(id)), false, `TV rec ${id} is no longer ignored`);
        }
      });
    });
  } finally {
    if (backup !== null) writeFileSync(recsPath, backup);
    else rmSync(recsPath, { force: true });
  }
}

// ── missing-seasons endpoints (T179): GET overlays ignored/notified; POST ignores ──
{
  const { plexConfig } = await import('../workflows/missing-tv-seasons/config.js');
  const { NOTIFY_JOB: PLEX_JOB, pairKey } = await import('../workflows/missing-tv-seasons/stages/notify.js');
  const { markWorkItem: mark, ignoredItemKeys: ignoredKeys } = await import('../db/store.js');

  const NOTIFIED_ID = 9980001;
  const FRESH_ID    = 9980002;
  const IGNORE_ID   = 9980003;
  const NOTIFIED_S  = 2;
  const FRESH_S     = 3;
  const IGNORE_S    = 1;
  const missingPath = plexConfig.missingOut;
  const hadFile = existsSync(missingPath);
  const backup = hadFile ? readFileSync(missingPath, 'utf8') : null;
  mkdirSync(join(missingPath, '..'), { recursive: true });
  writeFileSync(missingPath, JSON.stringify({
    generatedAt: '2026-06-01T00:00:00Z',
    shows: [
      { tmdbId: NOTIFIED_ID, title: 'Already Notified Show', year: 2019, ratingKey: 'r1', highestOwnedSeason: 1, tmdbStatus: 'Ended', highestAiredSeason: 3, completeMissingSeasons: [NOTIFIED_S] },
      { tmdbId: FRESH_ID,    title: 'Fresh Show', year: 2020, ratingKey: 'r2', highestOwnedSeason: 2, tmdbStatus: 'Returning Series', highestAiredSeason: 4, completeMissingSeasons: [FRESH_S] },
      { tmdbId: IGNORE_ID,   title: 'To Ignore Show', year: 2021, ratingKey: 'r3', highestOwnedSeason: 0, tmdbStatus: 'Ended', highestAiredSeason: 1, completeMissingSeasons: [IGNORE_S] },
    ],
    unverifiable: [],
  }));
  mark(PLEX_JOB, pairKey(NOTIFIED_ID, NOTIFIED_S), 'success');

  try {
    await test('GET /api/missing-seasons overlays notified + ignored status', async () => {
      await withServer({}, async (base) => {
        const data = (await (await fetch(`${base}/api/missing-seasons`)).json()) as {
          generatedAt: string | null;
          shows: { tmdbId: number; season: number; notified: boolean; ignored: boolean }[];
        };
        assert.ok(data.generatedAt, 'generatedAt is returned');
        const find = (id: number, s: number) => data.shows.find((x) => x.tmdbId === id && x.season === s);
        assert.equal(find(NOTIFIED_ID, NOTIFIED_S)?.notified, true, 'already-digested pair is flagged notified');
        assert.equal(find(FRESH_ID, FRESH_S)?.notified, false, 'fresh pair is not yet notified');
        assert.equal(find(FRESH_ID, FRESH_S)?.ignored, false);
      });
    });

    await test('POST /api/missing-seasons/:tmdbId/:season/ignore suppresses a season gap', async () => {
      await withServer({}, async (base) => {
        const res = await fetch(`${base}/api/missing-seasons/${IGNORE_ID}/${IGNORE_S}/ignore`, { method: 'POST' });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { ok: boolean; ignored: number };
        assert.equal(body.ok, true);
        assert.ok(body.ignored >= 1);
        assert.ok(ignoredKeys(PLEX_JOB).has(pairKey(IGNORE_ID, IGNORE_S)), 'ledger row is now ignored');

        const data = (await (await fetch(`${base}/api/missing-seasons`)).json()) as {
          shows: { tmdbId: number; season: number; ignored: boolean }[];
        };
        assert.equal(
          data.shows.find((s) => s.tmdbId === IGNORE_ID && s.season === IGNORE_S)?.ignored,
          true,
          'GET reflects the ignore',
        );
      });
    });

    await test('POST /api/missing-seasons/:tmdbId/:season/ignore rejects bad ids (400)', async () => {
      await withServer({}, async (base) => {
        const r1 = await fetch(`${base}/api/missing-seasons/not-a-number/1/ignore`, { method: 'POST' });
        assert.equal(r1.status, 400);
        const r2 = await fetch(`${base}/api/missing-seasons/9980001/bad-season/ignore`, { method: 'POST' });
        assert.equal(r2.status, 400);
      });
    });
  } finally {
    if (backup !== null) writeFileSync(missingPath, backup);
    else rmSync(missingPath, { force: true });
  }
}

// ── notify stage excludes ignored pairs from writeReport (T179) ──
{
  const { buildDigest, runNotify, NOTIFY_JOB: PLEX_JOB, pairKey } = await import('../workflows/missing-tv-seasons/stages/notify.js');
  const { ignoreSurfacedItem, isWorkItemDone } = await import('../db/store.js');
  const { existsSync: exists, readFileSync: readFS, mkdirSync: mkdirFS } = await import('node:fs');
  const { plexConfig } = await import('../workflows/missing-tv-seasons/config.js');
  const tmp = mkdtempSync(join(tmpdir(), 'notify-test-'));

  await test('buildDigest count and title', () => {
    const d = buildDigest([{ title: 'Show A', tmdbId: 1, seasons: [2, 3] }, { title: 'Show B', tmdbId: 2, seasons: [1] }]);
    assert.equal(d.count, 3);
    assert.ok(d.title.includes('3'));
  });

  await test('runNotify writeReport excludes ignored pairs (T179)', async () => {
    const missingFile = join(tmp, 'missing-seasons.json');
    const pushed: string[] = [];
    writeFileSync(missingFile, JSON.stringify({
      generatedAt: '2026-06-01T00:00:00Z',
      shows: [
        { tmdbId: 7001, title: 'Show Alpha', year: 2020, ratingKey: 'r1', highestOwnedSeason: 1, tmdbStatus: 'Ended', highestAiredSeason: 2, completeMissingSeasons: [2] },
        { tmdbId: 7002, title: 'Show Beta',  year: 2021, ratingKey: 'r2', highestOwnedSeason: 0, tmdbStatus: 'Ended', highestAiredSeason: 1, completeMissingSeasons: [1] },
      ],
      unverifiable: [],
    }));
    // Ignore Show Beta S1.
    ignoreSurfacedItem(PLEX_JOB, pairKey(7002, 1));

    mkdirFS(plexConfig.reportDir, { recursive: true });
    const logs: string[] = [];
    const ctx = {
      log: (msg: string) => { logs.push(msg); },
      progress: () => {},
      selectedRoots: () => null,
      rootAllowed: () => true,
    } as unknown as Parameters<typeof runNotify>[0];

    await runNotify(ctx, {
      push: async (title: string, body: string) => { pushed.push(title); return { ok: true }; },
      now: new Date('2026-06-25T00:00:00Z'),
      missingFile,
    });

    // Report file must NOT contain Show Beta.
    const { readFileSync: rfs } = await import('node:fs');
    const reportContent = rfs(plexConfig.reportDir + '/missing-seasons.md', 'utf8');
    assert.ok(reportContent.includes('Show Alpha'), 'report includes non-ignored show');
    assert.ok(!reportContent.includes('Show Beta'), 'report excludes ignored show');

    // Show Alpha S2 should be notified; Show Beta S1 is ignored so skipped.
    assert.ok(isWorkItemDone(PLEX_JOB, pairKey(7001, 2), 1), 'non-ignored season is marked notified');
    // pushed digest should reference Show Alpha, not Show Beta.
    assert.ok(pushed.some((t) => t.includes('1')), 'digest sent for 1 new season (only Alpha)');
  });
}

// ── GET /api/services/:name/consumers (T186) ────────────────────────────────
await test('GET /api/services/:name/consumers returns empty consumers for unknown service', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/services/no-such-service/consumers`);
    assert.equal(res.status, 200);
    const body = await res.json() as { consumers: unknown[] };
    assert.deepEqual(body.consumers, []);
  });
});

await test('GET /api/services/:name/consumers returns recorded consumers grouped by workflow', async () => {
  // Register a minimal workflow + job so workflow_jobs has a row.
  const consWfDef: WorkflowDefinition = {
    name: 'cons-api-wf',
    description: 'consumer test wf',
    schedule: null,
    jobs: [{ job: 'cons-api-job' }],
  };
  const consJobDef: JobDefinition = {
    name: 'cons-api-job',
    description: 'consumer test job',
    timeoutMs: 0,
    maxRetries: 0,
    async run() {},
  };
  syncJob(consJobDef);
  syncWorkflow(consWfDef);
  // Seed a consumer row.
  recordServiceConsumer('cons-svc', 'cons-api-job');

  await withServer({}, async (base) => {
    const res = await fetch(`${base}/api/services/cons-svc/consumers`);
    assert.equal(res.status, 200);
    const body = await res.json() as { consumers: { workflow_name: string | null; jobs: { job_name: string }[] }[] };
    assert.equal(body.consumers.length, 1);
    assert.equal(body.consumers[0].workflow_name, 'cons-api-wf');
    assert.equal(body.consumers[0].jobs.length, 1);
    assert.equal(body.consumers[0].jobs[0].job_name, 'cons-api-job');
  });
});

// ── T203: resetWorkflowOutput (store) + deleteDataOutContents + API endpoint ──
{
  const { resetWorkflowOutput: resetStore, getWorkflowRun: getWfRun } = await import('../db/store.js');
  const { deleteDataOutContents } = await import('./server.js');

  // Set up two workflows in the scratch DB so we can verify isolation.
  syncJob({ name: 't203-j1', run: async () => {} });
  syncJob({ name: 't203-j2', run: async () => {} });
  syncJob({ name: 't203-other', run: async () => {} });
  syncWorkflow({ name: 't203-wf', jobs: [{ job: 't203-j1' }, { job: 't203-j2' }] });
  syncWorkflow({ name: 't203-other-wf', jobs: [{ job: 't203-other' }] });

  // Seed runs + work items for the target workflow.
  markWorkItem('t203-j1', 'item-a', 'success');
  markWorkItem('t203-j2', 'item-b', 'failed', { attempts: 3 });
  const wfRunId = createWorkflowRun('t203-wf', 'manual');
  finishWorkflowRun(wfRunId, 'success');

  // Seed a run + work item for the OTHER workflow — these must NOT be cleared.
  markWorkItem('t203-other', 'other-item', 'success');
  const otherRunId = createWorkflowRun('t203-other-wf', 'manual');
  finishWorkflowRun(otherRunId, 'success');

  await test('resetWorkflowOutput: clears target workflow rows, leaves other workflow untouched', () => {
    const result = resetStore('t203-wf');
    // Target workflow: all records cleared.
    assert.ok(result.itemsDeleted >= 2, `expected ≥2 work_items deleted, got ${result.itemsDeleted}`);
    assert.ok(result.wfRunsDeleted >= 1, `expected ≥1 workflow_runs deleted, got ${result.wfRunsDeleted}`);
    // Other workflow: rows still present after the reset.
    assert.ok(getWfRun(otherRunId), 'other workflow run still exists');
    // Re-running reset on already-cleared workflow is a safe no-op.
    const again = resetStore('t203-wf');
    assert.equal(again.itemsDeleted, 0, 'second reset is a no-op');
    assert.equal(again.wfRunsDeleted, 0, 'second reset is a no-op');
  });

  // deleteDataOutContents path-safety guards.
  await test('deleteDataOutContents: rejects paths outside WORKFLOWS_ROOT or without /data/out/', () => {
    // A path outside WORKFLOWS_ROOT (e.g. tmpdir) must be rejected.
    assert.equal(deleteDataOutContents(tmpdir()), 0, 'tmpdir() is outside WORKFLOWS_ROOT — rejected');
    // A path within WORKFLOWS_ROOT but without /data/out/ in it must also be rejected.
    const WORKFLOWS_ROOT_REAL = realpathSync(fileURLToPath(new URL('../workflows', import.meta.url)));
    assert.equal(deleteDataOutContents(join(WORKFLOWS_ROOT_REAL, 'places')), 0, 'no /data/out/ — rejected');
  });

  // API endpoint: 404 for unknown workflow.
  await test('POST /api/workflows/:name/reset-output: 404 for unknown workflow', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/__no_such_wf__/reset-output`, { method: 'POST' });
      assert.equal(res.status, 404);
    });
  });

  await test('POST /api/workflows/:name/reset-output: 200 ok for a known workflow (no active run)', async () => {
    // Re-seed something to clear so the counts are non-trivial.
    markWorkItem('t203-j1', 'api-test-item', 'success');
    const seededRunId = createWorkflowRun('t203-wf', 'manual');
    finishWorkflowRun(seededRunId, 'success'); // must be finished; active runs → 409
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/t203-wf/reset-output`, { method: 'POST' });
      assert.equal(res.status, 200);
      const body = await res.json() as { ok: boolean; jobNames: string[]; itemsDeleted: number; wfRunsDeleted: number; filesRemoved: number };
      assert.equal(body.ok, true);
      assert.ok(Array.isArray(body.jobNames), 'jobNames is an array');
      assert.ok(body.jobNames.includes('t203-j1'), 'jobNames includes member job t203-j1');
      assert.ok(typeof body.itemsDeleted === 'number', 'itemsDeleted is a number');
      assert.ok(typeof body.filesRemoved === 'number', 'filesRemoved is a number');
      assert.ok(body.itemsDeleted >= 1, 'at least one item was deleted');
    });
  });

  // Cleanup registry stubs.
  for (const n of ['t203-j1', 't203-j2', 't203-other']) {
    const i = jobs.findIndex((x) => x.name === n); if (i >= 0) jobs.splice(i, 1);
  }
  for (const n of ['t203-wf', 't203-other-wf']) {
    const i = workflows.findIndex((x) => x.name === n); if (i >= 0) workflows.splice(i, 1);
  }
}

// ── T348: outputJob override routes the Output section to a non-terminal stage ──
{
  syncJob({ name: 't348-first', run: async () => {} });
  syncJob({ name: 't348-last', run: async () => {} });
  jobs.push({ name: 't348-first', run: async () => {} }, { name: 't348-last', run: async () => {} });
  const t348DefaultWf = { name: 't348-default-wf', jobs: [{ job: 't348-first' }, { job: 't348-last', dependsOn: ['t348-first'] }] };
  const t348OverrideWf = {
    name: 't348-override-wf',
    jobs: [{ job: 't348-first' }, { job: 't348-last', dependsOn: ['t348-first'] }],
    outputJob: 't348-first',
  };
  syncWorkflow(t348DefaultWf);
  syncWorkflow(t348OverrideWf);
  workflows.push(t348DefaultWf, t348OverrideWf);
  markWorkItem('t348-first', 'pos-1', 'success');
  // The terminal stage never records anything (mirrors stocks-notify).

  await test('output-items: no outputJob override — reads the terminal wave (empty here) as before', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/t348-default-wf/output-items`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { items: unknown[]; terminalJobs: string[] };
      assert.deepEqual(body.terminalJobs, ['t348-last']);
      assert.equal(body.items.length, 0, 'terminal stage has no ledger rows');
    });
  });

  await test('output-items: outputJob override reads the named member job instead of the terminal wave', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/t348-override-wf/output-items`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { items: Array<{ jobName: string; itemKey: string }>; terminalJobs: string[] };
      assert.deepEqual(body.terminalJobs, ['t348-first']);
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0]?.jobName, 't348-first');
      assert.equal(body.items[0]?.itemKey, 'pos-1');
    });
  });

  // Cleanup registry stubs.
  for (const n of ['t348-first', 't348-last']) {
    const i = jobs.findIndex((x) => x.name === n); if (i >= 0) jobs.splice(i, 1);
  }
  for (const n of ['t348-default-wf', 't348-override-wf']) {
    const i = workflows.findIndex((x) => x.name === n); if (i >= 0) workflows.splice(i, 1);
  }
}

// ── T322: POST /api/workflows/reset-output-all — bulk reset across every workflow ──
{
  const { isWorkItemDone: t322IsWorkItemDone } = await import('../db/store.js');
  syncJob({ name: 't322-j1', run: async () => {} });
  syncJob({ name: 't322-j2', run: async () => {} });
  syncWorkflow({ name: 't322-wf', jobs: [{ job: 't322-j1' }] });
  syncWorkflow({ name: 't322-active-wf', jobs: [{ job: 't322-j2' }] });

  // Target workflow: seed output data to be reset.
  markWorkItem('t322-j1', 'item-a', 'success');
  const wfRunId = createWorkflowRun('t322-wf', 'manual');
  finishWorkflowRun(wfRunId, 'success');

  // "Active run" workflow: seed output data too, but leave its workflow run
  // unfinished (status stays 'running') so `workflowRunInProgress` reports true.
  markWorkItem('t322-j2', 'item-b', 'success');
  createWorkflowRun('t322-active-wf', 'manual');

  await test('POST /api/workflows/reset-output-all: resets idle workflows, skips active ones', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/reset-output-all`, { method: 'POST' });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        ok: boolean;
        totalWorkflows: number;
        resetCount: number;
        skippedCount: number;
        results: Array<{ name: string; status: string; reason?: string; itemsDeleted?: number }>;
      };
      assert.equal(body.ok, true);
      assert.ok(body.totalWorkflows >= 2, 'covers at least the two seeded workflows');

      const targetResult = body.results.find((r) => r.name === 't322-wf');
      assert.ok(targetResult, 't322-wf present in results');
      assert.equal(targetResult?.status, 'reset');
      assert.ok((targetResult?.itemsDeleted ?? 0) >= 1, 't322-wf items were deleted');

      const activeResult = body.results.find((r) => r.name === 't322-active-wf');
      assert.ok(activeResult, 't322-active-wf present in results');
      assert.equal(activeResult?.status, 'skipped');
      assert.equal(activeResult?.reason, 'active run in progress');

      // Active workflow's data must be untouched.
      assert.equal(t322IsWorkItemDone('t322-j2', 'item-b', 3), true, 'active workflow work item untouched');

      assert.ok(body.resetCount >= 1);
      assert.ok(body.skippedCount >= 1);
    });
  });

  // Cleanup registry stubs.
  for (const n of ['t322-j1', 't322-j2']) {
    const i = jobs.findIndex((x) => x.name === n); if (i >= 0) jobs.splice(i, 1);
  }
  for (const n of ['t322-wf', 't322-active-wf']) {
    const i = workflows.findIndex((x) => x.name === n); if (i >= 0) workflows.splice(i, 1);
  }
}

// ── T591: POST /api/workflows/reset-output-all — skip certified workflows ──
{
  const { isWorkItemDone: t591IsWorkItemDone, setWorkflowCertified: t591SetCertified } = await import('../db/store.js');
  syncJob({ name: 't591-j1', run: async () => {} });
  syncJob({ name: 't591-j2', run: async () => {} });
  syncJob({ name: 't591-j3', run: async () => {} });
  syncWorkflow({ name: 't591-certified-wf', jobs: [{ job: 't591-j1' }] });
  syncWorkflow({ name: 't591-uncertified-wf', jobs: [{ job: 't591-j2' }] });
  syncWorkflow({ name: 't591-active-wf', jobs: [{ job: 't591-j3' }] });

  // Certified workflow: seed output data that should NOT be reset.
  markWorkItem('t591-j1', 'item-certified', 'success');
  const t591CertWfRunId = createWorkflowRun('t591-certified-wf', 'manual');
  finishWorkflowRun(t591CertWfRunId, 'success');
  t591SetCertified('t591-certified-wf', true);

  // Uncertified workflow: seed output data that SHOULD be reset.
  markWorkItem('t591-j2', 'item-uncertified', 'success');
  const t591UncertWfRunId = createWorkflowRun('t591-uncertified-wf', 'manual');
  finishWorkflowRun(t591UncertWfRunId, 'success');

  // Active workflow: seed output data but leave its run unfinished (should be skipped).
  markWorkItem('t591-j3', 'item-active', 'success');
  createWorkflowRun('t591-active-wf', 'manual');

  await test('POST /api/workflows/reset-output-all: skips certified and active workflows, resets others', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflows/reset-output-all`, { method: 'POST' });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        ok: boolean;
        totalWorkflows: number;
        resetCount: number;
        skippedCount: number;
        results: Array<{ name: string; status: string; reason?: string; itemsDeleted?: number }>;
      };
      assert.equal(body.ok, true);

      // Certified workflow should be skipped with 'certified' reason
      const certifiedResult = body.results.find((r) => r.name === 't591-certified-wf');
      assert.ok(certifiedResult, 't591-certified-wf present in results');
      assert.equal(certifiedResult?.status, 'skipped', 'certified workflow is skipped');
      assert.equal(certifiedResult?.reason, 'certified', 'certified reason is reported');

      // Certified workflow's data must be untouched.
      assert.equal(t591IsWorkItemDone('t591-j1', 'item-certified', 3), true, 'certified workflow work item untouched');

      // Uncertified workflow should be reset
      const uncertifiedResult = body.results.find((r) => r.name === 't591-uncertified-wf');
      assert.ok(uncertifiedResult, 't591-uncertified-wf present in results');
      assert.equal(uncertifiedResult?.status, 'reset', 'uncertified workflow is reset');
      assert.ok((uncertifiedResult?.itemsDeleted ?? 0) >= 1, 't591-uncertified-wf items were deleted');

      // Uncertified workflow's data must be cleared
      assert.equal(t591IsWorkItemDone('t591-j2', 'item-uncertified', 3), false, 'uncertified workflow work item deleted');

      // Active workflow should be skipped
      const activeResult = body.results.find((r) => r.name === 't591-active-wf');
      assert.ok(activeResult, 't591-active-wf present in results');
      assert.equal(activeResult?.status, 'skipped', 'active workflow is skipped');
      assert.equal(activeResult?.reason, 'active run in progress', 'active run reason is reported');

      // Active workflow's data must be untouched.
      assert.equal(t591IsWorkItemDone('t591-j3', 'item-active', 3), true, 'active workflow work item untouched');

      assert.ok(body.resetCount >= 1, 'at least one workflow was reset');
      assert.ok(body.skippedCount >= 2, 'at least two workflows were skipped (certified + active)');
    });
  });

  // Cleanup registry stubs.
  for (const n of ['t591-j1', 't591-j2', 't591-j3']) {
    const i = jobs.findIndex((x) => x.name === n); if (i >= 0) jobs.splice(i, 1);
  }
  for (const n of ['t591-certified-wf', 't591-uncertified-wf', 't591-active-wf']) {
    const i = workflows.findIndex((x) => x.name === n); if (i >= 0) workflows.splice(i, 1);
  }
}

// ── T478: GET /api/cache + POST /api/cache/clear — service_cache management ──
{
  const { setCachedServiceResponse: t478SetCache } = await import('../db/store.js');
  t478SetCache('t478-api-svc-a', 'k1', { x: 1 });
  t478SetCache('t478-api-svc-a', 'k2', { x: 2 });
  t478SetCache('t478-api-svc-b', 'k1', { y: 1 });

  await test('GET /api/cache: reports per-service row counts', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/cache`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { counts: Array<{ service_name: string; count: number }> };
      const a = body.counts.find((c) => c.service_name === 't478-api-svc-a');
      const b = body.counts.find((c) => c.service_name === 't478-api-svc-b');
      assert.equal(a?.count, 2);
      assert.equal(b?.count, 1);
    });
  });

  await test('POST /api/cache/clear { serviceName }: clears only that service', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/cache/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceName: 't478-api-svc-a' }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; cleared: number };
      assert.equal(body.ok, true);
      assert.equal(body.cleared, 2);

      const after = await (await fetch(`${base}/api/cache`)).json() as { counts: Array<{ service_name: string; count: number }> };
      assert.equal(after.counts.find((c) => c.service_name === 't478-api-svc-a'), undefined, 'cleared service is gone');
      assert.ok(after.counts.some((c) => c.service_name === 't478-api-svc-b'), 'other service untouched');
    });
  });

  await test('POST /api/cache/clear {}: clears every remaining service', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/cache/clear`, { method: 'POST' });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; cleared: number };
      assert.equal(body.ok, true);
      assert.equal(body.cleared, 1);

      const after = await (await fetch(`${base}/api/cache`)).json() as { counts: Array<{ service_name: string; count: number }> };
      assert.equal(after.counts.length, 0, 'service_cache is empty');
    });
  });
}

// ── T526: findWorkflowDataOut / deleteDataOutContents must never descend into a
// `data/` tree (e.g. projects-sync's cloned-repo copies), and must never let a
// name-matching clone with no data/out shadow the real workflow's data/out.
// Uses a synthetic fixture rooted under the REAL WORKFLOWS_ROOT (findWorkflowDataOut
// hardcodes that root at module-load time, so it can't be redirected) — always
// cleaned up in a finally, and named uniquely so it can never collide with a real
// tracked workflow folder.
{
  const WORKFLOWS_ROOT_FOR_TEST = fileURLToPath(new URL('../workflows', import.meta.url));
  const wfName = `t526-real-wf-${Date.now()}`;
  // Suffixed with the PID so two concurrent `npm test` processes (each in its own
  // process since T537) never race on the same real on-disk fixture path.
  const fixtureName = `__t526-fixture-${process.pid}__`;
  const realDir = join(WORKFLOWS_ROOT_FOR_TEST, fixtureName);
  const realOutDir = join(realDir, 'data', 'out');
  const cloneDir = join(realDir, 'data', 'repos', 'Cloned', fixtureName);
  const marker = join(realDir, 'clone-was-imported.marker');

  await test('findWorkflowDataOut skips data/ trees and resolves the real data/out, not a shadowing clone', async () => {
    rmSync(realDir, { recursive: true, force: true });
    try {
      mkdirSync(realOutDir, { recursive: true });
      writeFileSync(join(realDir, 'real.workflow.ts'), `export default { name: ${JSON.stringify(wfName)} };\n`);
      writeFileSync(join(realOutDir, 'output.txt'), 'real output');

      // A cloned copy of the SAME workflow name, nested under a `data/` folder
      // (mirrors projects-sync's repo clones), with NO data/out of its own.
      // Its import has a side effect (writes `marker`) so we can prove it was
      // never imported at all.
      mkdirSync(cloneDir, { recursive: true });
      writeFileSync(
        join(cloneDir, 'shadow.workflow.ts'),
        `import { writeFileSync } from 'node:fs';\n` +
          `writeFileSync(${JSON.stringify(marker)}, 'imported');\n` +
          `export default { name: ${JSON.stringify(wfName)} };\n`,
      );

      const { findWorkflowDataOut: findIt, deleteDataOutContents: deleteIt } =
        (await import('./server.js')) as typeof import('./server.js');

      const found = await findIt(wfName);
      assert.equal(found, realOutDir, 'must resolve the real data/out, not null and not the clone');
      assert.equal(existsSync(marker), false, 'the clone under data/ must never be imported');

      const filesRemoved = deleteIt(found as string);
      assert.ok(filesRemoved > 0, 'must actually delete the real data/out contents, not silently no-op (the false-success bug)');
      assert.equal(existsSync(join(realOutDir, 'output.txt')), false, 'the real output file was removed');
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });
}

console.log(`\n  ${passed} assertions passed`);
