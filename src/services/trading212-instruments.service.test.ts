// T425: the instruments-metadata endpoint gets its OWN service (separate from
// `trading212`) so its documented 1-request-per-50-seconds limit is enforced
// mechanically via minIntervalMs, not just by a code comment.
import assert from 'node:assert/strict';
import { callService, registerService } from '../core/services.js';
import { syncService } from '../db/store.js';
import trading212InstrumentsService from './trading212-instruments.service.js';

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

await test('trading212-instruments service definition sets a fixed 50s minIntervalMs by default', async () => {
  assert.equal(trading212InstrumentsService.name, 'trading212-instruments');
  assert.equal(trading212InstrumentsService.minIntervalMs, 50_000);
  assert.equal(trading212InstrumentsService.paid, false);
  assert.equal(trading212InstrumentsService.category, 'api');
});

// T502: instruments metadata is a stable mapping — cache reads for 22h so a
// stocks-sync + stock-digest run on the same day doesn't re-fetch the whole
// instruments list twice.
await test('trading212-instruments service definition caches reads for 22 hours', async () => {
  assert.equal(trading212InstrumentsService.cacheTtlMs, 79_200_000);
});

await test('a repeated lookup with the same t212-instruments:<key> cacheKey within 22h is served from service_cache, not a second live call', async () => {
  const testDef = { ...trading212InstrumentsService, name: 'trading212-instruments-cache-test', minIntervalMs: 0 };
  registerService(testDef);
  syncService(testDef);

  let calls = 0;
  const first = await callService(
    'trading212-instruments-cache-test',
    async () => {
      calls++;
      return [{ ticker: 'AAPL_US_EQ', name: 'Apple Inc' }];
    },
    { cacheKey: 't212-instruments:all' },
  );
  const second = await callService(
    'trading212-instruments-cache-test',
    async () => {
      calls++;
      return [{ ticker: 'AAPL_US_EQ', name: 'Apple Inc' }];
    },
    { cacheKey: 't212-instruments:all' },
  );

  assert.equal(calls, 1, 'the live fetch fn should be invoked once — the second call must be a cache hit');
  assert.deepEqual(second, first);
});

await test('trading212-instruments enforces minIntervalMs spacing mechanically (mirrors fragrantica)', async () => {
  // Register a copy with a short interval so the test stays fast — the mechanism
  // under test (callService's minIntervalMs gate) is identical regardless of the
  // configured spacing; only the real service's default (50_000ms) differs.
  const testDef = { ...trading212InstrumentsService, name: 'trading212-instruments-test', minIntervalMs: 2000 };
  registerService(testDef);
  syncService(testDef);

  await callService('trading212-instruments-test', async () => 'a'); // first call — no wait

  let waitedMs = -1;
  const out = await callService('trading212-instruments-test', async () => 'b', {
    onThrottle: (ms) => {
      waitedMs = ms;
    },
  });
  assert.equal(out, 'b');
  assert.ok(waitedMs >= 1, `a second call within the min interval should be throttled, got ${waitedMs}`);
});

await test('trading212-instruments and trading212 are governed independently (distinct service names)', async () => {
  assert.notEqual(trading212InstrumentsService.name, 'trading212');
});

console.log(`trading212-instruments.service.test.ts: ${passed} passed`);
