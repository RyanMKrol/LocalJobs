import assert from 'node:assert/strict';
import { callService, registerService } from '../core/services.js';
import { syncService } from '../db/store.js';
import tmdbService from './tmdb.service.js';

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

await test('tmdb service definition sets a 22-hour cacheTtlMs', async () => {
  assert.equal(tmdbService.name, 'tmdb');
  assert.equal(tmdbService.cacheTtlMs, 79_200_000);
  assert.equal(tmdbService.paid, false);
  assert.equal(tmdbService.category, 'api');
});

await test('a repeated tmdbGet for the same path within 22h is served from service_cache, not a second live call', async () => {
  const testDef = { ...tmdbService, name: 'tmdb-cache-test', ratePerMinute: 0 };
  registerService(testDef);
  syncService(testDef);

  let calls = 0;
  const path = '/tv/123/season/2';

  const first = await callService(
    'tmdb-cache-test',
    async () => {
      calls++;
      return { episodes: [{ id: 1 }] };
    },
    { cacheKey: `tmdb:${path}` },
  );

  const second = await callService(
    'tmdb-cache-test',
    async () => {
      calls++;
      return { episodes: [{ id: 1 }] };
    },
    { cacheKey: `tmdb:${path}` },
  );

  assert.equal(calls, 1, 'the live fetch fn should be invoked once — the second call must be a cache hit');
  assert.deepEqual(second, first);
});

console.log(`tmdb.service.test.ts: ${passed} passed`);
