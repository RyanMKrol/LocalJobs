// Unit tests for the route table's exact-segment-length matcher (T530). The
// matcher replaced a positional `parts[n] === '...'` if/else chain that had a
// real bug class: a check like `parts[3] === 'runs'` matched ANY path where
// segment 3 was `'runs'` regardless of how many MORE segments followed. These
// tests pin the fix directly against `matchRoute` (exported from `./server.js`)
// with small synthetic route tables — no DB, no HTTP server, no fixtures needed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { matchRoute } from './server.js';

function parts(path: string): string[] {
  return path.split('/').filter(Boolean);
}

await test('matchRoute: exact literal match', () => {
  const routes = [{ method: 'GET', pattern: '/api/health', handler: () => {} }];
  const found = matchRoute('GET', parts('/api/health'), routes);
  assert.ok(found);
  assert.equal(found!.route, routes[0]);
  assert.deepEqual(found!.params, {});
});

await test('matchRoute: :param segments are captured by name', () => {
  const routes = [{ method: 'GET', pattern: '/api/jobs/:name', handler: () => {} }];
  const found = matchRoute('GET', parts('/api/jobs/demo'), routes);
  assert.ok(found);
  assert.deepEqual(found!.params, { name: 'demo' });
});

await test('matchRoute: multiple :param segments in one pattern', () => {
  const routes = [{ method: 'GET', pattern: '/api/workflows/:name/gates/:producer/:key', handler: () => {} }];
  const found = matchRoute('GET', parts('/api/workflows/places/gates/ingest/cid'), routes);
  assert.ok(found);
  assert.deepEqual(found!.params, { name: 'places', producer: 'ingest', key: 'cid' });
});

await test('matchRoute: method mismatch does not match', () => {
  const routes = [{ method: 'POST', pattern: '/api/workflows/:name/toggle', handler: () => {} }];
  const found = matchRoute('GET', parts('/api/workflows/places/toggle'), routes);
  assert.equal(found, null);
});

await test('matchRoute: no route matches an unknown path (falls through to 404)', () => {
  const routes = [{ method: 'GET', pattern: '/api/health', handler: () => {} }];
  const found = matchRoute('GET', parts('/api/nope'), routes);
  assert.equal(found, null);
});

await test('matchRoute: a literal segment must match exactly (not just length)', () => {
  const routes = [{ method: 'GET', pattern: '/api/jobs/:name', handler: () => {} }];
  const found = matchRoute('GET', parts('/api/workflows/demo'), routes);
  assert.equal(found, null);
});

await test('matchRoute: first matching route wins when patterns could otherwise tie', () => {
  const first = { method: 'GET', pattern: '/api/a/:x', handler: () => {} };
  const second = { method: 'GET', pattern: '/api/a/:x', handler: () => {} };
  const found = matchRoute('GET', parts('/api/a/1'), [first, second]);
  assert.equal(found!.route, first);
});

// The regression this task exists to fix: the OLD dispatch (`parts[3] === 'runs'`
// with no length check) matched `/api/workflows/foo/runs/extra` because it only
// ever inspected segment 3, ignoring anything past it. The new matcher requires
// the path to have the SAME segment count as the pattern, so a path with extra
// trailing segments no longer matches a shorter pattern — it correctly falls
// through to nothing (404), even though `/api/workflows/:name/runs` is registered.
await test('regression: GET /api/workflows/foo/runs/extra does NOT match /api/workflows/:name/runs', () => {
  const routes = [{ method: 'GET', pattern: '/api/workflows/:name/runs', handler: () => {} }];
  const shortPath = matchRoute('GET', parts('/api/workflows/foo/runs'), routes);
  assert.ok(shortPath, 'the exact-length path must still match');
  assert.deepEqual(shortPath!.params, { name: 'foo' });

  const longPath = matchRoute('GET', parts('/api/workflows/foo/runs/extra'), routes);
  assert.equal(longPath, null, 'a path with an extra trailing segment must NOT match');
});

// Same regression class for the other loose `parts[3] === '...'`-style checks the
// old dispatch had with no explicit length guard (jobs/:name/runs, jobs/:name/prune).
await test('regression: GET /api/jobs/foo/runs/extra does NOT match /api/jobs/:name/runs', () => {
  const routes = [{ method: 'GET', pattern: '/api/jobs/:name/runs', handler: () => {} }];
  assert.ok(matchRoute('GET', parts('/api/jobs/foo/runs'), routes));
  assert.equal(matchRoute('GET', parts('/api/jobs/foo/runs/extra'), routes), null);
});
