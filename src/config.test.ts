import test from 'node:test';
import assert from 'node:assert/strict';
import { isTestEnv, resolveDbPath } from './config.js';

// The production-DB guard (prevents a test from ever writing to data/jobs.db —
// the leak that put test-fixture workflows into the live dashboard).

await test('isTestEnv: detects every test-invocation path, but not the daemon', () => {
  // explicit flag (set by scripts/run-tests.ts)
  assert.equal(isTestEnv({ LOCALJOBS_TEST: '1' }, []), true);
  // node --test / tsx --test worker
  assert.equal(isTestEnv({ NODE_TEST_CONTEXT: 'child-v8' }, []), true);
  // tsx --test …
  assert.equal(isTestEnv({}, ['node', 'tsx', '--test', 'src/api/server.test.ts']), true);
  // npm-test runner entry
  assert.equal(isTestEnv({}, ['node', '/repo/scripts/run-tests.ts']), true);
  // a test file passed directly (tsx src/x.test.ts)
  assert.equal(isTestEnv({}, ['node', '/repo/src/api/server.test.ts']), true);
  // the daemon / app entry points are NOT a test context
  assert.equal(isTestEnv({}, ['node', '/repo/src/daemon.ts']), false);
  assert.equal(isTestEnv({}, ['node', '/repo/src/runJob.ts']), false);
});

await test('resolveDbPath: a test context can never resolve to the production DB', () => {
  const prod = '/repo/data/jobs.db';
  const opts = { prodDefault: prod, pid: 123, tmp: '/tmp', warn: false as const };

  // In a test with NO override → redirected to a scratch DB, never prod.
  const noOverride = resolveDbPath({ ...opts, isTest: true });
  assert.notEqual(noOverride, prod);
  assert.match(noOverride, /lj-test-guard-123\.db$/);

  // In a test that explicitly points AT prod → still redirected (safety net).
  assert.notEqual(resolveDbPath({ ...opts, explicit: prod, isTest: true }), prod);

  // In a test with a scratch override → used as-is (what `npm test` does).
  assert.equal(resolveDbPath({ ...opts, explicit: '/tmp/lj-test.db', isTest: true }), '/tmp/lj-test.db');

  // Outside tests (the daemon) → production default and explicit overrides honoured.
  assert.equal(resolveDbPath({ ...opts, isTest: false }), prod);
  assert.equal(resolveDbPath({ ...opts, explicit: '/custom/place.db', isTest: false }), '/custom/place.db');
});
