// build.ts tests — verify callService('plex', ...) wrapper + pass-through in test env
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { callService } from '../../../core/services.js';

// ── callService('plex', ...) wrapper — pass-through when service unregistered ──
{
  let fnCalled = false;
  const result = await callService('plex', async () => {
    fnCalled = true;
    return { data: 'test', value: 42 };
  });
  assert.ok(fnCalled, 'callService passes through when plex service is unregistered in tests');
  assert.equal(result.data, 'test', 'result is returned unchanged');
  assert.equal(result.value, 42, 'result properties are preserved');
  console.log('  ✓ callService(\'plex\', ...) pass-through wrapper works (unregistered service in test)');
}

test('callService plex wrapper preserves return value and error handling', async () => {
  let callCount = 0;
  const results = [];

  // Test successful call
  const successResult = await callService('plex', async () => {
    callCount++;
    return { success: true };
  });
  results.push(successResult);
  assert.equal(callCount, 1, 'function was called once');
  assert.deepEqual(successResult, { success: true }, 'success result returned unchanged');

  // Test error propagation
  const testError = new Error('test plex error');
  await assert.rejects(
    () => callService('plex', async () => {
      callCount++;
      throw testError;
    }),
    testError,
    'errors are propagated correctly',
  );
  assert.equal(callCount, 2, 'function was called twice total');

  console.log('  ✓ callService(\'plex\', ...) preserves return values and errors');
});
