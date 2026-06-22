// Unit + integration tests for the API's security hardening (T023): CORS is an
// allowlist (never '*'), the server binds loopback by default, and mutating (POST)
// endpoints reject unauthorised callers. The pure helpers are tested directly; an
// ephemeral real server exercises the CORS reflection and the 401 guard end-to-end.
// `opts.isLoopback` lets us simulate a remote (non-loopback) caller without a second host.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { config } from '../config.js';
import { jobs, workflows } from '../jobs/registry.js';
import { syncJob, syncWorkflow } from '../db/store.js';
import type { JobDefinition, WorkflowDefinition } from '../core/types.js';
import {
  authoriseMutation,
  createApiServer,
  isLoopbackAddress,
  originAllowed,
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

console.log(`\n  ${passed} assertions passed`);
