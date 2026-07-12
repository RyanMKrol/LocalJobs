import assert from 'node:assert/strict';
import { callService, registerService } from '../core/services.js';
import { syncService } from '../db/store.js';
import googlePlacesService from './google-places.service.js';

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

await test('google-places service definition sets a 22-hour cacheTtlMs', async () => {
  assert.equal(googlePlacesService.name, 'google-places');
  assert.equal(googlePlacesService.cacheTtlMs, 79_200_000);
  assert.equal(googlePlacesService.paid, true);
  assert.equal(googlePlacesService.category, 'api');
});

await test('a repeated Place Details fetch for the same place_id within 22h is served from service_cache, not a second live call', async () => {
  const testDef = { ...googlePlacesService, name: 'google-places-cache-test', ratePerMinute: 0 };
  registerService(testDef);
  syncService(testDef);

  let calls = 0;
  const placeId = 'ChIJIQBpAG2qQIcR_6128GltTXQ';

  const first = await callService(
    'google-places-cache-test',
    async () => {
      calls++;
      return {
        displayName: { text: 'Test Place' },
        rating: 4.5,
      };
    },
    { cacheKey: `google-places:details:${placeId}` },
  );

  const second = await callService(
    'google-places-cache-test',
    async () => {
      calls++;
      return {
        displayName: { text: 'Test Place' },
        rating: 4.5,
      };
    },
    { cacheKey: `google-places:details:${placeId}` },
  );

  assert.equal(calls, 1, 'the live fetch fn should be invoked once — the second call must be a cache hit');
  assert.deepEqual(second, first);
});

console.log(`google-places.service.test.ts: ${passed} passed`);
