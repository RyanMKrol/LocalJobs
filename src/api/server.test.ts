// Unit + integration tests for the API's security hardening (T023): CORS is an
// allowlist (never '*'), the server binds loopback by default, and mutating (POST)
// endpoints reject unauthorised callers. The pure helpers are tested directly; an
// ephemeral real server exercises the CORS reflection and the 401 guard end-to-end.
// `opts.isLoopback` lets us simulate a remote (non-loopback) caller without a second host.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { jobs, workflows } from '../jobs/registry.js';
import { createWorkflowRun, finishWorkflowRun, getJob, getWorkflow, markWorkItem, recordServiceConsumer, syncJob, syncWorkflow } from '../db/store.js';
import { nextWorkflowRun, rescheduleWorkflow } from '../core/scheduler.js';
import type { ArtifactShape, JobDefinition, WorkflowDefinition } from '../core/types.js';
import {
  authoriseMutation,
  commitReviewsFile,
  createApiServer,
  isLoopbackAddress,
  isWithin,
  migrateReviewsOut,
  originAllowed,
  readHumanDone,
  readManualFail,
  readReviews,
  readTaskBuildFailures,
  readTaskSpec,
  readWorklogContent,
  safeOutputFile,
  safeOutputMarkdown,
  setHumanDoneEntry,
  setManualFailEntry,
  setReviewEntries,
  setReviewEntry,
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
  const jobsRoot = fileURLToPath(new URL('../jobs', import.meta.url));
  const outDir = `${jobsRoot}/perfumes/data/out/markdown`;
  const okFile = `${outDir}/__t110-test__.md`;
  const wrongDir = `${jobsRoot}/perfumes/data/raw/__t110-test__.md`; // not under data/out
  const txtFile = `${outDir}/__t110-test__.txt`; // not markdown
  mkdirSync(outDir, { recursive: true });
  mkdirSync(`${jobsRoot}/perfumes/data/raw`, { recursive: true });
  writeFileSync(okFile, '# Hi\n');
  writeFileSync(wrongDir, '# Hi\n');
  writeFileSync(txtFile, 'hi\n');

  await test('safeOutputMarkdown: accepts a real .md inside a job data/out tree', () => {
    assert.ok(safeOutputMarkdown(okFile), 'a real .md under data/out is allowed');
  });
  await test('safeOutputMarkdown: rejects null / traversal / outside / non-md / missing', () => {
    assert.equal(safeOutputMarkdown(null), null, 'null');
    assert.equal(safeOutputMarkdown('/etc/passwd'), null, 'outside the jobs tree');
    assert.equal(safeOutputMarkdown(`${outDir}/../../../../../../etc/passwd`), null, 'traversal escapes');
    assert.equal(safeOutputMarkdown(wrongDir), null, 'not under data/out');
    assert.equal(safeOutputMarkdown(txtFile), null, 'not a .md file');
    assert.equal(safeOutputMarkdown(`${outDir}/__does_not_exist__.md`), null, 'missing file');
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
  const jobsRoot = fileURLToPath(new URL('../jobs', import.meta.url));
  const outDir = `${jobsRoot}/perfumes/data/out/reports`;
  const jsonFile = `${outDir}/__t262-test__.json`;
  const outsideFile = `${jobsRoot}/perfumes/data/raw/__t262-outside__.json`; // not under data/out
  mkdirSync(outDir, { recursive: true });
  mkdirSync(`${jobsRoot}/perfumes/data/raw`, { recursive: true });
  writeFileSync(jsonFile, '{"ok":true}\n');
  writeFileSync(outsideFile, '{"bad":true}\n');

  await test('safeOutputFile: accepts any file type inside a job data/out tree', () => {
    assert.ok(safeOutputFile(jsonFile), 'a json file under data/out is allowed');
  });
  await test('safeOutputFile: rejects null / traversal / outside / missing', () => {
    assert.equal(safeOutputFile(null), null, 'null');
    assert.equal(safeOutputFile('/etc/passwd'), null, 'outside the jobs tree');
    assert.equal(safeOutputFile(`${outDir}/../../../../../../etc/passwd`), null, 'traversal escapes');
    assert.equal(safeOutputFile(outsideFile), null, 'not under data/out');
    assert.equal(safeOutputFile(`${outDir}/__no_such_file__.json`), null, 'missing file');
  });

  // Workflow output endpoint: markdown form (backward compat) vs declared non-markdown form
  syncJob({ name: 't262-out', run: async () => {} });
  syncWorkflow({ name: 't262-wf', jobs: [{ job: 't262-out' }] });
  // Markdown item (existing convention — detail.markdown, no detail.format)
  const mdFile = `${jobsRoot}/perfumes/data/out/markdown/__t262-md__.md`;
  mkdirSync(`${jobsRoot}/perfumes/data/out/markdown`, { recursive: true });
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

// ── T136: owner-owned reviews store — overlay + atomic write + migration + commit/push ──
{
  // A fixture backlog whose tasks no longer carry `reviewed` (it lives in reviews.json).
  const fixture = () =>
    JSON.stringify(
      {
        version: 1,
        defaults: { model: 'm', effort: 'e' },
        tasks: [
          { id: 'T1', title: 'A', status: 'done', tags: ['x'], nested: { keep: 1 } },
          { id: 'T2', title: 'B', status: 'done' },
          { id: 'T3', title: 'C', status: 'pending' },
        ],
      },
      null,
      2,
    ) + '\n';

  await test('setReviewEntry: sets ONLY the target id, preserves the rest; empty raw → {}', () => {
    const seeded = setReviewEntry('', 'T1', true, '2026-06-23T00:00:00.000Z');
    let map = JSON.parse(seeded) as Record<string, { reviewed: boolean; at: string }>;
    assert.deepEqual(Object.keys(map), ['T1'], 'empty raw starts from {}');
    assert.equal(map.T1.reviewed, true);
    assert.equal(map.T1.at, '2026-06-23T00:00:00.000Z');

    const out = setReviewEntry(seeded, 'T2', false, '2026-06-23T01:00:00.000Z');
    map = JSON.parse(out) as Record<string, { reviewed: boolean; at: string }>;
    assert.equal(map.T1.reviewed, true, 'sibling id preserved');
    assert.equal(map.T2.reviewed, false, 'target set');

    // Flip an existing id; others untouched.
    const flipped = JSON.parse(setReviewEntry(out, 'T1', false, '2026-06-23T02:00:00.000Z')) as Record<
      string,
      { reviewed: boolean }
    >;
    assert.equal(flipped.T1.reviewed, false);
    assert.equal(flipped.T2.reviewed, false);
  });

  await test('setReviewEntries: sets multiple ids, preserves others; empty raw → {}', () => {
    const seeded = setReviewEntries('', ['T1', 'T2'], true, '2026-06-25T00:00:00.000Z');
    let map = JSON.parse(seeded) as Record<string, { reviewed: boolean; at: string }>;
    assert.deepEqual(Object.keys(map).sort(), ['T1', 'T2'], 'both ids set from empty raw');
    assert.equal(map.T1.reviewed, true);
    assert.equal(map.T2.reviewed, true);
    assert.equal(map.T1.at, '2026-06-25T00:00:00.000Z');

    // Pre-existing T3 must survive when we bulk-set T1+T2.
    const withT3 = JSON.stringify({ T3: { reviewed: false, at: 'x' } });
    const out = setReviewEntries(withT3, ['T1', 'T2'], true, '2026-06-25T01:00:00.000Z');
    map = JSON.parse(out) as Record<string, { reviewed: boolean; at: string }>;
    assert.equal(map.T3.reviewed, false, 'sibling T3 preserved');
    assert.equal(map.T1.reviewed, true, 'T1 set');
    assert.equal(map.T2.reviewed, true, 'T2 set');

    // Overwrite an existing entry in the batch.
    const overwritten = JSON.parse(setReviewEntries(out, ['T1'], false, '2026-06-25T02:00:00.000Z')) as Record<string, { reviewed: boolean }>;
    assert.equal(overwritten.T1.reviewed, false, 'T1 overwritten to false');
    assert.equal(overwritten.T2.reviewed, true, 'T2 untouched');
    assert.equal(overwritten.T3.reviewed, false, 'T3 untouched');
  });

  await test('migrateReviewsOut: strips reviewed from tasks; seeds reviews from reviewed:true', () => {
    const tasksRaw =
      JSON.stringify({
        version: 1,
        tasks: [
          { id: 'T1', title: 'A', status: 'done', reviewed: true, nested: { keep: 1 } },
          { id: 'T2', title: 'B', status: 'done', reviewed: false },
          { id: 'T3', title: 'C', status: 'pending' },
        ],
      }) + '\n';
    const { tasksJson, reviewsJson } = migrateReviewsOut(tasksRaw, '2026-06-23T00:00:00.000Z');
    const tasks = (JSON.parse(tasksJson) as { tasks: Array<Record<string, unknown>> }).tasks;
    for (const t of tasks) assert.equal('reviewed' in t, false, `reviewed stripped from ${t.id}`);
    assert.deepEqual(tasks.find((t) => t.id === 'T1')!.nested, { keep: 1 }, 'other fields preserved');
    assert.equal(tasks.find((t) => t.id === 'T2')!.status, 'done', 'status preserved');
    const reviews = JSON.parse(reviewsJson) as Record<string, { reviewed: boolean; at: string }>;
    assert.deepEqual(Object.keys(reviews), ['T1'], 'only reviewed:true seeded');
    assert.equal(reviews.T1.reviewed, true);
    assert.equal(reviews.T1.at, '2026-06-23T00:00:00.000Z');
  });

  // A throwaway backlog + reviews dir the endpoint reads/writes (no git → push no-ops).
  const dir = mkdtempSync(join(tmpdir(), 'localjobs-backlog-'));
  const backlogPath = join(dir, 'TASKS.json');
  const reviewsPath = join(dir, 'reviews.json');
  // Inject a commitReviews that does NOT touch git (this temp dir isn't a repo).
  const noGit = async () => ({ committed: false, pushed: false });

  await test('readReviews: absent file → {}, present file overlays', () => {
    assert.deepEqual(readReviews(join(dir, 'does-not-exist.json')), {});
    writeFileSync(reviewsPath, JSON.stringify({ T1: { reviewed: true } }) + '\n');
    assert.equal(readReviews(reviewsPath).T1?.reviewed, true);
    rmSync(reviewsPath, { force: true });
  });

  await test('GET /api/backlog: overlays reviewed from reviews.json (absent → false)', async () => {
    writeFileSync(backlogPath, fixture());
    writeFileSync(reviewsPath, JSON.stringify({ T1: { reviewed: true }, T3: { reviewed: false } }) + '\n');
    await withServer({ backlogPath, reviewsPath, commitReviews: noGit }, async (base) => {
      const res = await fetch(`${base}/api/backlog`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { tasks: Array<{ id: string; reviewed: boolean }> };
      const byId = Object.fromEntries(body.tasks.map((t) => [t.id, t.reviewed]));
      assert.equal(byId['T1'], true, 'overlaid from reviews.json');
      assert.equal(byId['T2'], false, 'absent in reviews → false');
      assert.equal(byId['T3'], false, 'explicit false');
    });
    rmSync(reviewsPath, { force: true });
  });

  await test('POST /api/backlog/:id/reviewed: atomically writes ONLY that id to reviews.json', async () => {
    writeFileSync(backlogPath, fixture());
    writeFileSync(reviewsPath, JSON.stringify({ T1: { reviewed: true, at: 'x' } }) + '\n');
    await withServer({ backlogPath, reviewsPath, commitReviews: noGit }, async (base) => {
      const res = await fetch(`${base}/api/backlog/T2/reviewed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewed: true }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; id: string; reviewed: boolean; committed: boolean; pushed: boolean };
      assert.equal(body.ok, true);
      assert.equal(body.id, 'T2');
      assert.equal(body.reviewed, true);
      assert.equal(body.pushed, false, 'no git in temp dir → push false');
      // TASKS.json is NEVER written by this endpoint anymore.
      const tasksOnDisk = JSON.parse(readFileSync(backlogPath, 'utf8')) as { tasks: Array<Record<string, unknown>> };
      for (const t of tasksOnDisk.tasks) assert.equal('reviewed' in t, false, 'TASKS.json untouched (no reviewed field)');
      // reviews.json carries both ids, the existing one preserved.
      const reviews = JSON.parse(readFileSync(reviewsPath, 'utf8')) as Record<string, { reviewed: boolean }>;
      assert.equal(reviews.T1.reviewed, true, 'sibling id preserved');
      assert.equal(reviews.T2.reviewed, true, 'new id written');
    });
    rmSync(reviewsPath, { force: true });
  });

  await test('POST /api/backlog/reviewed-bulk: writes all ids to reviews.json in one shot', async () => {
    writeFileSync(backlogPath, fixture());
    writeFileSync(reviewsPath, JSON.stringify({ T1: { reviewed: false, at: 'x' } }) + '\n');
    const noGitBulk = async () => ({ committed: false, pushed: false });
    await withServer({ backlogPath, reviewsPath, commitReviewsBulk: noGitBulk }, async (base) => {
      const res = await fetch(`${base}/api/backlog/reviewed-bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['T2', 'T3'] }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; ids: string[]; count: number; committed: boolean };
      assert.equal(body.ok, true);
      assert.equal(body.count, 2);
      assert.deepEqual(body.ids.sort(), ['T2', 'T3']);
      // reviews.json must contain T2 + T3 as reviewed; T1 (pre-existing) preserved.
      const reviews = JSON.parse(readFileSync(reviewsPath, 'utf8')) as Record<string, { reviewed: boolean }>;
      assert.equal(reviews.T1.reviewed, false, 'pre-existing T1 preserved');
      assert.equal(reviews.T2.reviewed, true, 'T2 set');
      assert.equal(reviews.T3.reviewed, true, 'T3 set');
    });
    rmSync(reviewsPath, { force: true });
  });

  await test('POST /api/backlog/reviewed-bulk: 400 on empty ids or bad id format', async () => {
    writeFileSync(backlogPath, fixture());
    const noGitBulk = async () => ({ committed: false, pushed: false });
    await withServer({ backlogPath, reviewsPath, commitReviewsBulk: noGitBulk }, async (base) => {
      const rEmpty = await fetch(`${base}/api/backlog/reviewed-bulk`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [] }),
      });
      assert.equal(rEmpty.status, 400, 'empty ids rejected');
      const rBad = await fetch(`${base}/api/backlog/reviewed-bulk`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['T1', 'notvalid'] }),
      });
      assert.equal(rBad.status, 400, 'invalid id format rejected');
    });
  });

  await test('POST /api/backlog/:id/reviewed: 400 for a bad id format and a non-boolean', async () => {
    writeFileSync(backlogPath, fixture());
    await withServer({ backlogPath, reviewsPath, commitReviews: noGit }, async (base) => {
      const rBadId = await fetch(`${base}/api/backlog/__nope__/reviewed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewed: true }),
      });
      assert.equal(rBadId.status, 400, 'non T\\d+ id rejected');
      const r400 = await fetch(`${base}/api/backlog/T1/reviewed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewed: 'yes' }),
      });
      assert.equal(r400.status, 400);
    });
    rmSync(reviewsPath, { force: true });
  });

  // Integration: commit+push the reviews file against a LOCAL BARE remote (no network).
  // Skips cleanly if git is unavailable.
  await test('commitReviewsFile: commits ONLY reviews.json + pushes to a local bare remote', async () => {
    let haveGit = true;
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
    } catch {
      haveGit = false;
    }
    if (!haveGit) {
      console.log('    (skipped — git not available)');
      return;
    }
    const gitRoot = mkdtempSync(join(tmpdir(), 'localjobs-gitrepo-'));
    const bare = mkdtempSync(join(tmpdir(), 'localjobs-bare-'));
    const g = (args: string[], cwd = gitRoot) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    try {
      execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
      g(['init', '-b', 'main']);
      g(['config', 'user.email', 'test@example.com']);
      g(['config', 'user.name', 'Test']);
      g(['config', 'commit.gpgsign', 'false']);
      const harnessDir = join(gitRoot, '.harness', 'tracking');
      mkdirSync(harnessDir, { recursive: true });
      writeFileSync(join(harnessDir, 'TASKS.json'), '{"tasks":[]}\n');
      writeFileSync(join(gitRoot, 'README.md'), '# test\n');
      g(['add', '-A']);
      g(['commit', '-m', 'init']);
      g(['remote', 'add', 'origin', bare]);
      g(['push', 'origin', 'HEAD:main']);

      // Reproduce production: the owner's global git config forces signing on
      // every commit. The daemon runs headlessly (launchd — no TTY/pinentry), so
      // an ordinary commit would FAIL to sign and silently leave reviews.json
      // staged-but-uncommitted. commitReviewsFile MUST pass `--no-gpg-sign` to
      // succeed here despite gpgsign=true with no signing key available.
      g(['config', 'commit.gpgsign', 'true']);

      // The endpoint's durability floor: write the reviews file first.
      const revPath = join(harnessDir, 'reviews.json');
      writeFileSync(revPath, JSON.stringify({ T9: { reviewed: true, at: '2026-06-23T00:00:00.000Z' } }, null, 2) + '\n');

      const result = await commitReviewsFile({
        repoRoot: gitRoot,
        reviewsAbsPath: revPath,
        id: 'T9',
        reviewed: true,
        mainBranch: 'main',
        timeoutMs: 20_000,
      });
      assert.equal(result.committed, true, 'committed');
      assert.equal(result.pushed, true, `pushed (warning: ${result.warning ?? ''})`);

      // The HEAD commit must touch ONLY .harness/tracking/reviews.json.
      const changed = execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], { cwd: gitRoot, encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean);
      assert.deepEqual(changed, ['.harness/tracking/reviews.json'], 'commit touches ONLY reviews.json');

      // The bare remote must have received it.
      const remoteContent = execFileSync('git', ['show', 'main:.harness/tracking/reviews.json'], { cwd: bare, encoding: 'utf8' });
      assert.match(remoteContent, /"T9"/, 'reviews.json reached the bare remote');
      // The lock dir must be released (not left behind).
      assert.equal(existsSync(join(gitRoot, '.git', `${basename(gitRoot)}-loop.lock`)), false, 'lock released');
    } finally {
      rmSync(gitRoot, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  });

  rmSync(dir, { recursive: true, force: true });
}

// ── T208: human-done overlay — POST /api/backlog/:id/done + GET overlay ──
{
  const dir2 = mkdtempSync(join(tmpdir(), 'localjobs-humandone-'));
  const backlogPath = join(dir2, 'TASKS.json');
  const reviewsPath = join(dir2, 'reviews.json');
  const humanDonePath = join(dir2, 'human-done.json');
  const noGit = async () => ({ committed: false, pushed: false });

  const fixture = () =>
    JSON.stringify(
      {
        version: 1,
        tasks: [
          { id: 'T10', title: 'NH task', status: 'pending', gate: 'needs-human' },
          { id: 'T11', title: 'Buildable task', status: 'pending', gate: null },
          { id: 'T12', title: 'Done task', status: 'done', gate: null },
        ],
      },
      null,
      2,
    ) + '\n';

  await test('setHumanDoneEntry: sets only the target id, preserves rest; empty raw → {}', () => {
    const out = setHumanDoneEntry('', 'T10', '2026-06-26T00:00:00.000Z');
    const map = JSON.parse(out) as Record<string, { done: boolean; at: string }>;
    assert.deepEqual(Object.keys(map), ['T10']);
    assert.equal(map.T10.done, true);
    assert.equal(map.T10.at, '2026-06-26T00:00:00.000Z');
    const out2 = setHumanDoneEntry(out, 'T11', '2026-06-26T01:00:00.000Z');
    const map2 = JSON.parse(out2) as Record<string, { done: boolean }>;
    assert.equal(map2.T10.done, true, 'sibling preserved');
    assert.equal(map2.T11.done, true, 'new id set');
  });

  await test('readHumanDone: absent file → {}, present file reads correctly', () => {
    assert.deepEqual(readHumanDone(join(dir2, 'does-not-exist.json')), {});
    writeFileSync(humanDonePath, JSON.stringify({ T10: { done: true, at: 'x' } }) + '\n');
    assert.equal(readHumanDone(humanDonePath).T10?.done, true);
    rmSync(humanDonePath, { force: true });
  });

  await test('POST /api/backlog/:id/done: marks needs-human task done; GET overlays done+reviewed=true', async () => {
    writeFileSync(backlogPath, fixture());
    rmSync(humanDonePath, { force: true });
    await withServer({ backlogPath, reviewsPath, humanDonePath, commitHumanDone: noGit }, async (base) => {
      const res = await fetch(`${base}/api/backlog/T10/done`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; id: string; done: boolean };
      assert.equal(body.ok, true);
      assert.equal(body.id, 'T10');
      assert.equal(body.done, true);

      // human-done.json written to disk
      const onDisk = JSON.parse(readFileSync(humanDonePath, 'utf8')) as Record<string, { done: boolean }>;
      assert.equal(onDisk.T10.done, true);

      // GET /api/backlog overlays done=true and reviewed=true for T10
      const get = await fetch(`${base}/api/backlog`);
      assert.equal(get.status, 200);
      const bl = (await get.json()) as { tasks: Array<{ id: string; done?: boolean; reviewed?: boolean }> };
      const t10 = bl.tasks.find((t) => t.id === 'T10');
      assert.ok(t10, 'T10 in backlog');
      assert.equal(t10!.done, true, 'done overlaid');
      assert.equal(t10!.reviewed, true, 'reviewed derived from done');
    });
    rmSync(humanDonePath, { force: true });
  });

  await test('POST /api/backlog/:id/done: 400 for non-needs-human task', async () => {
    writeFileSync(backlogPath, fixture());
    await withServer({ backlogPath, reviewsPath, humanDonePath, commitHumanDone: noGit }, async (base) => {
      const rBuildable = await fetch(`${base}/api/backlog/T11/done`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      assert.equal(rBuildable.status, 400, 'non-needs-human buildable task rejected');
      const rDone = await fetch(`${base}/api/backlog/T12/done`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      assert.equal(rDone.status, 400, 'non-needs-human done task rejected');
    });
  });

  await test('POST /api/backlog/:id/done: 400 for invalid task id format', async () => {
    writeFileSync(backlogPath, fixture());
    await withServer({ backlogPath, reviewsPath, humanDonePath, commitHumanDone: noGit }, async (base) => {
      const r = await fetch(`${base}/api/backlog/__bad__/done`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      assert.equal(r.status, 400, 'invalid id rejected');
    });
  });

  await test('GET /api/backlog: human-done task without explicit reviews.json still shows reviewed=true', async () => {
    writeFileSync(backlogPath, fixture());
    writeFileSync(humanDonePath, JSON.stringify({ T10: { done: true, at: '2026-06-26T00:00:00.000Z' } }) + '\n');
    rmSync(reviewsPath, { force: true });
    await withServer({ backlogPath, reviewsPath, humanDonePath, commitHumanDone: noGit }, async (base) => {
      const res = await fetch(`${base}/api/backlog`);
      const bl = (await res.json()) as { tasks: Array<{ id: string; done?: boolean; reviewed?: boolean }> };
      const t10 = bl.tasks.find((t) => t.id === 'T10');
      assert.equal(t10!.done, true);
      assert.equal(t10!.reviewed, true);
      const t11 = bl.tasks.find((t) => t.id === 'T11');
      assert.equal(t11!.done, undefined, 'non-done task has no done field');
      assert.equal(t11!.reviewed, false, 'non-done task not reviewed');
    });
    rmSync(humanDonePath, { force: true });
  });

  rmSync(dir2, { recursive: true, force: true });
}

// ── manual-fail overlay — POST /api/backlog/:id/failed + GET overlay ──
{
  const dir3 = mkdtempSync(join(tmpdir(), 'localjobs-manualfail-'));
  const backlogPath = join(dir3, 'TASKS.json');
  const reviewsPath = join(dir3, 'reviews.json');
  const humanDonePath = join(dir3, 'human-done.json');
  const manualFailPath = join(dir3, 'manual-fail.json');
  const noGit = async () => ({ committed: false, pushed: false });

  const fixture = () =>
    JSON.stringify(
      {
        version: 1,
        tasks: [
          { id: 'T20', title: 'Done task', status: 'done', gate: null },
          { id: 'T21', title: 'Pending task', status: 'pending', gate: null },
        ],
      },
      null,
      2,
    ) + '\n';

  await test('setManualFailEntry: marks one id, preserves siblings; failed=false deletes', () => {
    const out = setManualFailEntry('', 'T20', true, 'padlock never renders', '2026-06-29T00:00:00.000Z');
    const map = JSON.parse(out) as Record<string, { failed: boolean; reason: string; at: string }>;
    assert.deepEqual(Object.keys(map), ['T20']);
    assert.equal(map.T20.failed, true);
    assert.equal(map.T20.reason, 'padlock never renders');
    const out2 = setManualFailEntry(out, 'T21', true, 'x', '2026-06-29T01:00:00.000Z');
    assert.equal((JSON.parse(out2) as Record<string, unknown>).T20 !== undefined, true, 'sibling preserved');
    const out3 = setManualFailEntry(out2, 'T20', false, '', ''); // undo
    const map3 = JSON.parse(out3) as Record<string, unknown>;
    assert.equal(map3.T20, undefined, 'failed=false removes the entry');
    assert.ok(map3.T21, 'other id preserved on undo');
  });

  await test('readManualFail: absent file → {}, present reads correctly', () => {
    assert.deepEqual(readManualFail(join(dir3, 'nope.json')), {});
    writeFileSync(manualFailPath, JSON.stringify({ T20: { failed: true, reason: 'r', at: 'x' } }) + '\n');
    assert.equal(readManualFail(manualFailPath).T20?.failed, true);
    rmSync(manualFailPath, { force: true });
  });

  await test('POST /api/backlog/:id/failed: marks done task failed; GET overlays failed+reviewed=true', async () => {
    writeFileSync(backlogPath, fixture());
    rmSync(manualFailPath, { force: true });
    await withServer({ backlogPath, reviewsPath, humanDonePath, manualFailPath, commitManualFail: noGit }, async (base) => {
      const res = await fetch(`${base}/api/backlog/T20/failed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'padlock never renders' }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; id: string; failed: boolean };
      assert.equal(body.ok, true);
      assert.equal(body.failed, true);

      const onDisk = JSON.parse(readFileSync(manualFailPath, 'utf8')) as Record<string, { failed: boolean; reason: string }>;
      assert.equal(onDisk.T20.failed, true);
      assert.equal(onDisk.T20.reason, 'padlock never renders');

      const get = await fetch(`${base}/api/backlog`);
      const bl = (await get.json()) as { tasks: Array<{ id: string; failed?: boolean; failReason?: string; reviewed?: boolean }> };
      const t20 = bl.tasks.find((t) => t.id === 'T20');
      assert.equal(t20!.failed, true, 'failed overlaid');
      assert.equal(t20!.failReason, 'padlock never renders', 'reason overlaid');
      assert.equal(t20!.reviewed, true, 'failed implies reviewed');
    });
    rmSync(manualFailPath, { force: true });
  });

  await test('POST /api/backlog/:id/failed: { failed:false } undoes a prior mark', async () => {
    writeFileSync(backlogPath, fixture());
    writeFileSync(manualFailPath, JSON.stringify({ T20: { failed: true, reason: 'r', at: 'x' } }) + '\n');
    await withServer({ backlogPath, reviewsPath, humanDonePath, manualFailPath, commitManualFail: noGit }, async (base) => {
      const res = await fetch(`${base}/api/backlog/T20/failed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ failed: false }),
      });
      assert.equal(res.status, 200);
      const onDisk = JSON.parse(readFileSync(manualFailPath, 'utf8')) as Record<string, unknown>;
      assert.equal(onDisk.T20, undefined, 'entry removed on undo');
    });
    rmSync(manualFailPath, { force: true });
  });

  await test('POST /api/backlog/:id/failed: 400 for pending task, missing reason, or bad id', async () => {
    writeFileSync(backlogPath, fixture());
    rmSync(manualFailPath, { force: true });
    await withServer({ backlogPath, reviewsPath, humanDonePath, manualFailPath, commitManualFail: noGit }, async (base) => {
      const rPending = await fetch(`${base}/api/backlog/T21/failed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'x' }),
      });
      assert.equal(rPending.status, 400, 'pending (not done) task rejected');
      const rNoReason = await fetch(`${base}/api/backlog/T20/failed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      assert.equal(rNoReason.status, 400, 'missing reason rejected');
      const rBad = await fetch(`${base}/api/backlog/__bad__/failed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'x' }),
      });
      assert.equal(rBad.status, 400, 'invalid id rejected');
    });
  });

  rmSync(dir3, { recursive: true, force: true });
}

// ── T131: per-task Markdown spec — readTaskSpec + GET inlines specContent + loop prompt ──
{
  // readTaskSpec resolves a JSON `spec` path (relative to the repo root) against the
  // backlog file's dir, confined to <baseDir>/tasks/*.md. Mirror the real layout:
  // baseDir = <root>/<harnessDir>, spec = "<harnessDir>/tasks/<file>.md".
  const root = mkdtempSync(join(tmpdir(), 'localjobs-spec-'));
  const baseDir = join(root, '.harness');
  const tasksDir = join(baseDir, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const harnessName = basename(baseDir);
  writeFileSync(join(tasksDir, 't-a.md'), '## Do\n\nbuild it\n\n## Done when\n\ngreen\n');

  await test('readTaskSpec: reads the spec markdown for a valid in-tree path', () => {
    const md = readTaskSpec(`${harnessName}/tasks/t-a.md`, baseDir);
    assert.ok(md && md.includes('## Do') && md.includes('## Done when') && md.includes('build it'));
  });

  await test('readTaskSpec: null for absent/non-string/non-md/traversal/missing', () => {
    assert.equal(readTaskSpec(undefined, baseDir), null);
    assert.equal(readTaskSpec(42, baseDir), null);
    assert.equal(readTaskSpec(`${harnessName}/tasks/t-a.txt`, baseDir), null);
    // A traversal that climbs out of <baseDir>/tasks/ is rejected even if the file exists.
    assert.equal(readTaskSpec(`${harnessName}/tasks/../../escape.md`, baseDir), null);
    assert.equal(readTaskSpec(`${harnessName}/tasks/missing.md`, baseDir), null);
  });

  // GET /api/backlog must inline each task's spec markdown as `specContent` (T131),
  // and must NOT carry the removed flat do/doneWhen fields.
  const backlogPath = join(baseDir, 'TASKS.json');
  writeFileSync(
    backlogPath,
    JSON.stringify(
      {
        version: 1,
        tasks: [
          { id: 't-a', title: 'A', status: 'pending', spec: `${harnessName}/tasks/t-a.md` },
          { id: 't-b', title: 'B', status: 'pending', spec: `${harnessName}/tasks/nope.md` },
        ],
      },
      null,
      2,
    ) + '\n',
  );

  await test('GET /api/backlog: inlines specContent (and omits it when the file is missing)', async () => {
    await withServer({ backlogPath, harnessDir: baseDir }, async (base) => {
      const res = await fetch(`${base}/api/backlog`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { tasks: Array<Record<string, unknown>> };
      const a = body.tasks.find((t) => t.id === 't-a')!;
      const b = body.tasks.find((t) => t.id === 't-b')!;
      assert.ok(typeof a.specContent === 'string' && (a.specContent as string).includes('## Done when'));
      assert.equal(a.do, undefined, 'no flat do field');
      assert.equal(a.doneWhen, undefined, 'no flat doneWhen field');
      assert.equal(b.specContent, undefined, 'missing spec file → no specContent');
      assert.equal(a.reviewed, false, 'reviewed still defaults to false');
    });
  });

  rmSync(root, { recursive: true, force: true });
}

// ── T231: worklog inlining — readWorklogContent + GET /api/backlog inlines worklogContent ──
{
  const root = mkdtempSync(join(tmpdir(), 'localjobs-worklog-'));
  const baseDir = join(root, '.harness');
  const worklogDir = join(baseDir, 'worklog');
  const tasksDir = join(baseDir, 'tasks');
  mkdirSync(worklogDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  const harnessName = basename(baseDir);
  writeFileSync(join(worklogDir, 'T001.md'), '# T001\n\ndone: built it\n');
  writeFileSync(join(tasksDir, 'T001.md'), '## Do\n\nbuild\n\n## Done when\n\ngreen\n');

  await test('readWorklogContent: reads worklog markdown for a valid id', () => {
    const md = readWorklogContent('T001', baseDir);
    assert.ok(md && md.includes('done: built it'));
  });

  await test('readWorklogContent: null for missing worklog', () => {
    assert.equal(readWorklogContent('T999', baseDir), null);
  });

  await test('readWorklogContent: null for traversal / invalid ids', () => {
    assert.equal(readWorklogContent('../escape', baseDir), null);
    assert.equal(readWorklogContent('../../etc/passwd', baseDir), null);
    assert.equal(readWorklogContent('T001/bad', baseDir), null);
    assert.equal(readWorklogContent(null, baseDir), null);
    assert.equal(readWorklogContent(42, baseDir), null);
  });

  const backlogPath = join(baseDir, 'TASKS.json');
  writeFileSync(
    backlogPath,
    JSON.stringify(
      {
        version: 1,
        tasks: [
          { id: 'T001', title: 'A', status: 'done', spec: `${harnessName}/tasks/T001.md` },
          { id: 'T002', title: 'B', status: 'pending' },
        ],
      },
      null,
      2,
    ) + '\n',
  );

  await test('GET /api/backlog: inlines worklogContent when worklog file exists', async () => {
    await withServer({ backlogPath, harnessDir: baseDir }, async (base) => {
      const res = await fetch(`${base}/api/backlog`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { tasks: Array<Record<string, unknown>> };
      const a = body.tasks.find((t) => t.id === 'T001')!;
      const b = body.tasks.find((t) => t.id === 'T002')!;
      assert.ok(typeof a.worklogContent === 'string' && (a.worklogContent as string).includes('done: built it'));
      assert.equal(b.worklogContent, undefined, 'no worklog → no worklogContent');
    });
  });

  rmSync(root, { recursive: true, force: true });
}

// ── T294: readTaskBuildFailures + GET /api/backlog inlines buildFailures ──
{
  const root = mkdtempSync(join(tmpdir(), 'localjobs-buildfailures-'));
  const baseDir = join(root, '.harness');
  const ledgersDir = join(baseDir, 'ledgers');
  mkdirSync(ledgersDir, { recursive: true });
  writeFileSync(
    join(ledgersDir, 'failures.jsonl'),
    [
      JSON.stringify({ id: 'T-fake-1', ts: '2026-07-01T05:18:12Z', kind: 'audit-fail', detail: 'first attempt' }),
      JSON.stringify({ id: 'T-fake-1', ts: '2026-07-01T09:16:02Z', kind: 'agent-blocked', detail: 'second, later attempt' }),
      JSON.stringify({ id: 'T-fake-2', ts: '2026-07-01T06:00:00Z', kind: 'ci-red', detail: 'only attempt' }),
      '', // blank lines are tolerated
    ].join('\n') + '\n',
  );

  await test('readTaskBuildFailures: aggregates multiple rows for one id, picking the latest by ts', () => {
    const result = readTaskBuildFailures('T-fake-1', baseDir);
    assert.deepEqual(result, {
      count: 2,
      latestKind: 'agent-blocked',
      latestDetail: 'second, later attempt',
      latestAt: '2026-07-01T09:16:02Z',
    });
  });

  await test('readTaskBuildFailures: a singleton row for a different id', () => {
    const result = readTaskBuildFailures('T-fake-2', baseDir);
    assert.deepEqual(result, {
      count: 1,
      latestKind: 'ci-red',
      latestDetail: 'only attempt',
      latestAt: '2026-07-01T06:00:00Z',
    });
  });

  await test('readTaskBuildFailures: null for an id with no matching rows', () => {
    assert.equal(readTaskBuildFailures('T-fake-none', baseDir), null);
  });

  await test('readTaskBuildFailures: null for traversal / invalid ids / missing file', () => {
    assert.equal(readTaskBuildFailures('../escape', baseDir), null);
    assert.equal(readTaskBuildFailures(null, baseDir), null);
    assert.equal(readTaskBuildFailures(42, baseDir), null);
    assert.equal(readTaskBuildFailures('T-fake-1', join(root, 'no-such-dir')), null);
  });

  const backlogPath = join(baseDir, 'TASKS.json');
  writeFileSync(
    backlogPath,
    JSON.stringify(
      {
        version: 1,
        tasks: [
          { id: 'T-fake-1', title: 'Has failures', status: 'pending' },
          { id: 'T-fake-2', title: 'Also has failures', status: 'pending' },
          { id: 'T-fake-none', title: 'No failures', status: 'pending' },
        ],
      },
      null,
      2,
    ) + '\n',
  );

  await test('GET /api/backlog: inlines buildFailures when failures.jsonl has matching rows, omits it otherwise', async () => {
    await withServer({ backlogPath, harnessDir: baseDir }, async (base) => {
      const res = await fetch(`${base}/api/backlog`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { tasks: Array<Record<string, unknown>> };
      const a = body.tasks.find((t) => t.id === 'T-fake-1')!;
      const c = body.tasks.find((t) => t.id === 'T-fake-none')!;
      assert.deepEqual(a.buildFailures, {
        count: 2,
        latestKind: 'agent-blocked',
        latestDetail: 'second, later attempt',
        latestAt: '2026-07-01T09:16:02Z',
      });
      assert.equal(c.buildFailures, undefined, 'no matching rows → no buildFailures');
    });
  });

  rmSync(root, { recursive: true, force: true });
}

// The loop builds each task's prompt from the referenced spec MD (T131). Source ONLY
// loop.sh's helpers (LOOP_SOURCE_ONLY=1) and call `prompt <id>`; the output must embed
// the task's ## Do / ## Done when from .harness/tasks/<id>.md. Skipped if jq is absent.
{
  const loopSh = fileURLToPath(new URL('../../.harness/scripts/loop.sh', import.meta.url));
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  let hasJq = true;
  try {
    execFileSync('bash', ['-c', 'command -v jq'], { stdio: 'ignore' });
  } catch {
    hasJq = false;
  }

  await test('loop.sh prompt(): embeds the task spec markdown (## Do / ## Done when)', () => {
    if (!hasJq) {
      console.log('    (skipped — jq not available)');
      return;
    }
    const out = execFileSync(
      'bash',
      ['-c', `LOOP_SOURCE_ONLY=1 source ${JSON.stringify(loopSh)}; prompt T001`],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    assert.ok(out.includes('## Do'), 'prompt contains the ## Do section');
    assert.ok(out.includes('## Done when'), 'prompt contains the ## Done when section');
    assert.ok(out.includes('.harness/tasks/T001.md'), 'prompt names the spec file');
  });
}

// ── T139: GET /api/workflow-runs/:id/io is run-scoped ──
// A run that advanced items returns only those items + scoped:true; a sibling run
// with no linkage returns empty + scoped:false + an honest emptyReason (NOT the
// global ledger dump).
{
  syncJob({ name: 'io-first', run: async () => {} });
  syncJob({ name: 'io-last', run: async () => {} });
  syncWorkflow({ name: 'io-api-wf', jobs: [{ job: 'io-first' }, { job: 'io-last', dependsOn: ['io-first'] }] });

  const ioRunA = createWorkflowRun('io-api-wf', 'manual');
  markWorkItem('io-first', 'k1', 'success', { workflowRunId: ioRunA });
  markWorkItem('io-last', 'k1', 'success', { rootKey: 'k1', workflowRunId: ioRunA });
  const ioRunEmpty = createWorkflowRun('io-api-wf', 'manual'); // advanced nothing

  await test('GET /api/workflow-runs/:id/io is run-scoped (T139)', async () => {
    await withServer({}, async (base) => {
      const a = (await (await fetch(`${base}/api/workflow-runs/${ioRunA}/io`)).json()) as {
        io: { inputKey: string }[]; scoped: boolean; emptyReason: string | null; note: string;
        selectedJob: string | null; scopedProducerJobs: string[]; scopedConsumerJobs: string[];
      };
      assert.equal(a.scoped, true, 'run with linkage is scoped');
      assert.deepEqual(a.io.map((r) => r.inputKey), ['k1'], 'only this run\'s input');
      assert.ok(!/first cut/i.test(a.note), 'note no longer says "first cut"');

      const empty = (await (await fetch(`${base}/api/workflow-runs/${ioRunEmpty}/io`)).json()) as {
        io: unknown[]; scoped: boolean; emptyReason: string | null;
      };
      assert.equal(empty.scoped, false, 'no-linkage run is not scoped');
      assert.equal(empty.io.length, 0, 'no global ledger dump');
      assert.equal(empty.emptyReason, 'no-new', 'workflow has linkage elsewhere → no-new (not pre-feature)');

      // Default (no ?job) response carries neutral-default new fields (T313).
      assert.equal(a.selectedJob, null, 'no job param -> selectedJob null');
      assert.deepEqual(a.scopedProducerJobs, [], 'no job param -> scopedProducerJobs empty');
      assert.deepEqual(a.scopedConsumerJobs, [], 'no job param -> scopedConsumerJobs empty');
    });
  });
}

// ── T313: GET /api/workflow-runs/:id/io?job=<X> scopes to a single stage's own
// direct predecessor(s) -> itself, instead of the whole-workflow first/last wave.
{
  syncJob({ name: 'io3-first', run: async () => {} });
  syncJob({ name: 'io3-mid', run: async () => {} });
  syncJob({ name: 'io3-last', run: async () => {} });
  syncWorkflow({
    name: 'io3-api-wf',
    jobs: [
      { job: 'io3-first' },
      { job: 'io3-mid', dependsOn: ['io3-first'] },
      { job: 'io3-last', dependsOn: ['io3-mid'] },
    ],
  });

  const io3Run = createWorkflowRun('io3-api-wf', 'manual');
  markWorkItem('io3-first', 'r1', 'success', { workflowRunId: io3Run });
  markWorkItem('io3-mid', 'r1', 'success', { rootKey: 'r1', workflowRunId: io3Run });
  markWorkItem('io3-last', 'r1', 'success', { rootKey: 'r1', workflowRunId: io3Run });

  await test('GET /api/workflow-runs/:id/io?job=<root job> self-pairs producer/consumer (T313)', async () => {
    await withServer({}, async (base) => {
      const body = (await (await fetch(`${base}/api/workflow-runs/${io3Run}/io?job=io3-first`)).json()) as {
        selectedJob: string; scopedProducerJobs: string[]; scopedConsumerJobs: string[];
        io: { inputKey: string; outputStatus: string | null }[];
      };
      assert.equal(body.selectedJob, 'io3-first');
      assert.deepEqual(body.scopedProducerJobs, ['io3-first']);
      assert.deepEqual(body.scopedConsumerJobs, ['io3-first']);
      assert.deepEqual(body.io.map((r) => r.inputKey), ['r1']);
    });
  });

  await test('GET /api/workflow-runs/:id/io?job=<mid job> scopes to its direct predecessor(s) (T313)', async () => {
    await withServer({}, async (base) => {
      const body = (await (await fetch(`${base}/api/workflow-runs/${io3Run}/io?job=io3-mid`)).json()) as {
        selectedJob: string; scopedProducerJobs: string[]; scopedConsumerJobs: string[];
        io: { inputKey: string; outputJob: string | null; outputStatus: string | null }[];
      };
      assert.equal(body.selectedJob, 'io3-mid');
      assert.deepEqual(body.scopedProducerJobs, ['io3-first']);
      assert.deepEqual(body.scopedConsumerJobs, ['io3-mid']);
      assert.equal(body.io.length, 1);
      assert.equal(body.io[0].outputJob, 'io3-mid', 'output reflects the mid stage itself, not the terminal stage');
      assert.equal(body.io[0].outputStatus, 'success');
    });
  });

  await test('GET /api/workflow-runs/:id/io?job=<unknown job> -> 400 (T313)', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/workflow-runs/${io3Run}/io?job=not-a-real-job`);
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /unknown job/);
    });
  });
}

// ── movie-gaps endpoints (T145): GET overlays ignored/notified; POST ignores ──
{
  const { moviesConfig } = await import('../jobs/movies/config.js');
  const { NOTIFY_JOB, gapKey } = await import('../jobs/movies/stages/notify.js');
  const { markWorkItem: mark, ignoredItemKeys: ignoredKeys } = await import('../db/store.js');

  // Distinct synthetic tmdbIds; back up + restore the real gaps file so a dev box's
  // audit output is never clobbered.
  const NOTIFIED = 9970001;
  const FRESH = 9970002;
  const TO_IGNORE = 9970003;
  const gapsPath = moviesConfig.gapsOut;
  const hadFile = existsSync(gapsPath);
  const backup = hadFile ? readFileSync(gapsPath, 'utf8') : null;
  mkdirSync(moviesConfig.outDir, { recursive: true });
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
  const { moviesConfig } = await import('../jobs/movies/config.js');
  const { RECS_JOB, recKey } = await import('../jobs/movies/recs.js');
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
  } finally {
    if (backup !== null) writeFileSync(recsPath, backup);
    else rmSync(recsPath, { force: true });
  }
}

// ── tv-recs endpoints (T219): GET overlays ignored/notified; POST ignores ──
{
  const { tvRecsConfig } = await import('../jobs/tv-recs/config.js');
  const { RECS_JOB: TV_RECS_JOB, recKey: tvRecKey } = await import('../jobs/tv-recs/recs.js');
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
  } finally {
    if (backup !== null) writeFileSync(recsPath, backup);
    else rmSync(recsPath, { force: true });
  }
}

// ── missing-seasons endpoints (T179): GET overlays ignored/notified; POST ignores ──
{
  const { plexConfig } = await import('../jobs/plex/config.js');
  const { NOTIFY_JOB: PLEX_JOB, pairKey } = await import('../jobs/plex/stages/notify.js');
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
  const { buildDigest, runNotify, NOTIFY_JOB: PLEX_JOB, pairKey } = await import('../jobs/plex/stages/notify.js');
  const { ignoreSurfacedItem, isWorkItemDone } = await import('../db/store.js');
  const { existsSync: exists, readFileSync: readFS, mkdirSync: mkdirFS } = await import('node:fs');
  const { plexConfig } = await import('../jobs/plex/config.js');
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
  await test('deleteDataOutContents: rejects paths outside JOBS_ROOT or without /data/out/', () => {
    // A path outside JOBS_ROOT (e.g. tmpdir) must be rejected.
    assert.equal(deleteDataOutContents(tmpdir()), 0, 'tmpdir() is outside JOBS_ROOT — rejected');
    // A path within JOBS_ROOT but without /data/out/ in it must also be rejected.
    const JOBS_ROOT_REAL = realpathSync(fileURLToPath(new URL('../jobs', import.meta.url)));
    assert.equal(deleteDataOutContents(join(JOBS_ROOT_REAL, 'places')), 0, 'no /data/out/ — rejected');
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

console.log(`\n  ${passed} assertions passed`);
