// Unit + integration tests for the API's security hardening (T023): CORS is an
// allowlist (never '*'), the server binds loopback by default, and mutating (POST)
// endpoints reject unauthorised callers. The pure helpers are tested directly; an
// ephemeral real server exercises the CORS reflection and the 401 guard end-to-end.
// `opts.isLoopback` lets us simulate a remote (non-loopback) caller without a second host.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { jobs, workflows } from '../jobs/registry.js';
import { createWorkflowRun, finishWorkflowRun, getWorkflow, markWorkItem, syncJob, syncWorkflow } from '../db/store.js';
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
  readReviews,
  readTaskSpec,
  safeOutputMarkdown,
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
      const harnessDir = join(gitRoot, '.harness');
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

      // The HEAD commit must touch ONLY .harness/reviews.json.
      const changed = execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], { cwd: gitRoot, encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean);
      assert.deepEqual(changed, ['.harness/reviews.json'], 'commit touches ONLY reviews.json');

      // The bare remote must have received it.
      const remoteContent = execFileSync('git', ['show', 'main:.harness/reviews.json'], { cwd: bare, encoding: 'utf8' });
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
    await withServer({ backlogPath }, async (base) => {
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

// The loop builds each task's prompt from the referenced spec MD (T131). Source ONLY
// loop.sh's helpers (LOOP_SOURCE_ONLY=1) and call `prompt <id>`; the output must embed
// the task's ## Do / ## Done when from .harness/tasks/<id>.md. Skipped if jq is absent.
{
  const loopSh = fileURLToPath(new URL('../../.harness/loop.sh', import.meta.url));
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
  } finally {
    if (backup !== null) writeFileSync(gapsPath, backup);
    else rmSync(gapsPath, { force: true });
  }
}

console.log(`\n  ${passed} assertions passed`);
