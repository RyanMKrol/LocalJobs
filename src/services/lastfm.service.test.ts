import assert from 'node:assert/strict';
import { callService, registerService } from '../core/services.js';
import { syncService } from '../db/store.js';
import lastfmService from './lastfm.service.js';

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

await test('lastfm service definition sets a 22-hour cacheTtlMs', async () => {
  assert.equal(lastfmService.name, 'lastfm');
  assert.equal(lastfmService.cacheTtlMs, 79_200_000);
  assert.equal(lastfmService.paid, false);
  assert.equal(lastfmService.category, 'api');
});

await test('a repeated top-albums/top-tracks fetch for the same period within 22h is served from service_cache, not a second live call', async () => {
  const testDef = { ...lastfmService, name: 'lastfm-cache-test', ratePerMinute: 0 };
  registerService(testDef);
  syncService(testDef);

  let calls = 0;

  const firstAlbums = await callService(
    'lastfm-cache-test',
    async () => {
      calls++;
      return { topalbums: { album: [{ name: 'Album 1', artist: { name: 'Artist' } }] } };
    },
    { cacheKey: 'lastfm:top-albums:1month' },
  );

  const secondAlbums = await callService(
    'lastfm-cache-test',
    async () => {
      calls++;
      return { topalbums: { album: [{ name: 'Album 2', artist: { name: 'Artist' } }] } };
    },
    { cacheKey: 'lastfm:top-albums:1month' },
  );

  assert.equal(calls, 1, 'the live fetch fn should be invoked once — the second call must be a cache hit');
  assert.deepEqual(secondAlbums, firstAlbums);

  const firstTracks = await callService(
    'lastfm-cache-test',
    async () => {
      calls++;
      return { toptracks: { track: [{ name: 'Track 1', artist: { name: 'Artist' } }] } };
    },
    { cacheKey: 'lastfm:top-tracks:3month' },
  );

  const secondTracks = await callService(
    'lastfm-cache-test',
    async () => {
      calls++;
      return { toptracks: { track: [{ name: 'Track 2', artist: { name: 'Artist' } }] } };
    },
    { cacheKey: 'lastfm:top-tracks:3month' },
  );

  assert.equal(calls, 2, 'two different cache keys should result in two live calls');
  assert.deepEqual(secondTracks, firstTracks);
});

console.log(`lastfm.service.test.ts: ${passed} passed`);
