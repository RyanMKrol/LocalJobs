import assert from 'node:assert/strict';
import { callService, registerService } from '../core/services.js';
import { syncService } from '../db/store.js';
import hevyService from './hevy.service.js';

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

await test('hevy service definition sets a 22-hour cacheTtlMs', async () => {
  assert.equal(hevyService.name, 'hevy');
  assert.equal(hevyService.cacheTtlMs, 79_200_000);
  assert.equal(hevyService.paid, false);
  assert.equal(hevyService.category, 'api');
});

await test('a repeated fetch of the same workouts page within 22h is served from service_cache, not a second live call', async () => {
  const testDef = { ...hevyService, name: 'hevy-cache-test', ratePerMinute: 0 };
  registerService(testDef);
  syncService(testDef);

  let calls = 0;

  const firstPage = await callService(
    'hevy-cache-test',
    async () => {
      calls++;
      return { page: 1, page_count: 1, workouts: [{ id: 'w1', title: 'Workout 1', description: '', start_time: '2026-01-01T08:00:00Z', end_time: '2026-01-01T09:00:00Z', updated_at: '2026-01-01T09:00:00Z', created_at: '2026-01-01T09:00:00Z', exercises: [] }] };
    },
    { cacheKey: 'hevy:workouts:1' },
  );

  const secondPage1 = await callService(
    'hevy-cache-test',
    async () => {
      calls++;
      return { page: 1, page_count: 1, workouts: [{ id: 'w2', title: 'Workout 2', description: '', start_time: '2026-01-01T08:00:00Z', end_time: '2026-01-01T09:00:00Z', updated_at: '2026-01-01T09:00:00Z', created_at: '2026-01-01T09:00:00Z', exercises: [] }] };
    },
    { cacheKey: 'hevy:workouts:1' },
  );

  assert.equal(calls, 1, 'the live fetch fn should be invoked once — the second call must be a cache hit');
  assert.deepEqual(secondPage1, firstPage);

  const firstPage2 = await callService(
    'hevy-cache-test',
    async () => {
      calls++;
      return { page: 2, page_count: 2, workouts: [{ id: 'w3', title: 'Workout 3', description: '', start_time: '2026-01-01T08:00:00Z', end_time: '2026-01-01T09:00:00Z', updated_at: '2026-01-01T09:00:00Z', created_at: '2026-01-01T09:00:00Z', exercises: [] }] };
    },
    { cacheKey: 'hevy:workouts:2' },
  );

  const secondPage2 = await callService(
    'hevy-cache-test',
    async () => {
      calls++;
      return { page: 2, page_count: 2, workouts: [{ id: 'w4', title: 'Workout 4', description: '', start_time: '2026-01-01T08:00:00Z', end_time: '2026-01-01T09:00:00Z', updated_at: '2026-01-01T09:00:00Z', created_at: '2026-01-01T09:00:00Z', exercises: [] }] };
    },
    { cacheKey: 'hevy:workouts:2' },
  );

  assert.equal(calls, 2, 'two different cache keys should result in two live calls');
  assert.deepEqual(secondPage2, firstPage2);
});

console.log(`hevy.service.test.ts: ${passed} passed`);
