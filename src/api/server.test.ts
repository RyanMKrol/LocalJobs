// Unit + integration tests for the API's security hardening (T023): CORS is an
// allowlist (never '*'), the server binds loopback by default, and mutating (POST)
// endpoints reject unauthorised callers. The pure helpers are tested directly; an
// ephemeral real server exercises the CORS reflection and the 401 guard end-to-end.
// `opts.isLoopback` lets us simulate a remote (non-loopback) caller without a second host.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { jobs, workflows } from '../jobs/registry.js';
import { createWorkflowRun, finishWorkflowRun, markWorkItem, syncJob, syncWorkflow } from '../db/store.js';
import type { ArtifactShape, JobDefinition, WorkflowDefinition } from '../core/types.js';
import {
  authoriseMutation,
  createApiServer,
  isLoopbackAddress,
  isWithin,
  originAllowed,
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
      };
      assert.equal(body.gate.producer, 'gate-up');
      assert.equal(body.gate.consumer, 'gate-down');
      assert.equal(body.gate.key, 'artA');
      assert.match(body.gate.description ?? '', /the A artifact/);
      assert.equal(body.produced.shape?.summary, 'rows of stuff');
      assert.equal(body.consumed.shape?.summary, 'consumes A');
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

console.log(`\n  ${passed} assertions passed`);
