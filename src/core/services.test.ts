// Unit tests for the shared service limiter (callService): day/month QUOTA →
// soft-fail throw, per-minute RATE throttle, and fixed MIN-INTERVAL spacing.
// Runs against the scratch DB (LOCALJOBS_DB) and the in-process service registry.
// callService has no injectable clock, so the throttle paths use real (short)
// sleeps bounded by maxWaitMs; the timeout paths use a negative maxWaitMs to throw
// on the first loop iteration (no sleep) and stay fast.
import assert from 'node:assert/strict';
import { callService, effectiveServiceTimeoutMs, QuotaExceededError, registerService } from './services.js';
import { recordServiceCall, serviceCallsToday, syncService, listServiceConsumers, updateServiceLimits } from '../db/store.js';

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

// Register each test service (callService reads the in-process registry, not the DB).
function svc(def: Parameters<typeof registerService>[0]) {
  registerService(def);
  syncService(def);
}

await test('an unregistered service runs ungated (missing *.service.ts never blocks work)', async () => {
  const out = await callService('svc-unknown', async () => 42);
  assert.equal(out, 42);
  assert.equal(serviceCallsToday('svc-unknown'), 0); // nothing metered
});

await test('a no-limit service meters one row per call and returns the result', async () => {
  svc({ name: 'svc-nolimit' });
  const out = await callService('svc-nolimit', async () => 'ok');
  assert.equal(out, 'ok');
  assert.equal(serviceCallsToday('svc-nolimit'), 1);
  await callService('svc-nolimit', async () => 'ok');
  assert.equal(serviceCallsToday('svc-nolimit'), 2);
});

await test('monthly quota exhausted → QuotaExceededError (retryable soft-fail), fn NOT run', async () => {
  svc({ name: 'svc-month', monthlyCap: 1 });
  recordServiceCall('svc-month'); // consume the only monthly slot
  let ran = false;
  await assert.rejects(
    () => callService('svc-month', async () => { ran = true; }),
    (e) => e instanceof QuotaExceededError && e.window === 'monthly' && e.retryable === true,
  );
  assert.equal(ran, false); // gate fired before the call
});

await test('daily quota exhausted → QuotaExceededError(daily)', async () => {
  svc({ name: 'svc-day', dailyCap: 2, monthlyCap: 1000 });
  recordServiceCall('svc-day');
  recordServiceCall('svc-day');
  await assert.rejects(
    () => callService('svc-day', async () => {}),
    (e) => e instanceof QuotaExceededError && e.window === 'daily' && e.used === 2 && e.cap === 2,
  );
});

await test('rate throttle: under the limit runs immediately; a no-slot wait throws when maxWait is exceeded', async () => {
  svc({ name: 'svc-rate', ratePerMinute: 1 });
  let throttled = false;
  const out = await callService('svc-rate', async () => 'first', { onThrottle: () => { throttled = true; } });
  assert.equal(out, 'first');
  assert.equal(throttled, false); // first call got the slot without waiting
  assert.equal(serviceCallsToday('svc-rate'), 1); // the reservation IS the usage row

  // slot now exhausted for the trailing 60s — a negative maxWait makes the wait
  // loop give up on its first iteration (no sleep), proving the throttle branch.
  await assert.rejects(
    () => callService('svc-rate', async () => 'second', { maxWaitMs: -1 }),
    (e) => e instanceof Error && /rate limit/.test(e.message),
  );
  assert.equal(serviceCallsToday('svc-rate'), 1); // the blocked call reserved nothing
});

await test('min-interval: first call immediate; second call THROTTLES until the gap elapses, then runs', async () => {
  svc({ name: 'svc-mi', minIntervalMs: 2000 });
  const t0 = Date.now();
  await callService('svc-mi', async () => 'a'); // no prior call → immediate
  assert.ok(Date.now() - t0 < 1000, 'first min-interval call should not wait');

  let waitedMs = -1;
  const out = await callService('svc-mi', async () => 'b', { onThrottle: (ms) => { waitedMs = ms; } });
  assert.equal(out, 'b');
  assert.ok(waitedMs >= 1, `onThrottle should report a real wait, got ${waitedMs}`);
  assert.equal(serviceCallsToday('svc-mi'), 2); // both calls eventually metered
});

await test('min-interval: a no-slot wait throws once maxWait is exceeded (min-interval takes precedence over rate)', async () => {
  svc({ name: 'svc-mi-to', minIntervalMs: 60_000, ratePerMinute: 100 });
  await callService('svc-mi-to', async () => {}); // records the gating call
  await assert.rejects(
    () => callService('svc-mi-to', async () => {}, { maxWaitMs: -1 }),
    (e) => e instanceof Error && /min-interval/.test(e.message),
  );
});

// ── service_consumers (T186) ────────────────────────────────────────────────
// callService records the calling job via process.argv[2]. In the test runner
// process.argv[2] is the test file path, so we can't test the auto-capture here;
// instead we import recordServiceConsumer directly and test the DB + API layer.
import { recordServiceConsumer } from '../db/store.js';

await test('recordServiceConsumer upserts a distinct (service, job) pair', async () => {
  recordServiceConsumer('svc-consumer-test', 'job-a');
  recordServiceConsumer('svc-consumer-test', 'job-b');
  recordServiceConsumer('svc-consumer-test', 'job-a'); // duplicate — should not add a second row
  const rows = listServiceConsumers('svc-consumer-test');
  const jobs = rows.map((r) => r.job_name).sort();
  assert.deepEqual(jobs, ['job-a', 'job-b']);
});

await test('listServiceConsumers returns only rows for the named service', async () => {
  recordServiceConsumer('svc-cons-x', 'job-x');
  recordServiceConsumer('svc-cons-y', 'job-y');
  const rows = listServiceConsumers('svc-cons-x');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].job_name, 'job-x');
  assert.equal(rows[0].service_name, 'svc-cons-x');
});

await test('listServiceConsumers returns empty array for unknown service', async () => {
  const rows = listServiceConsumers('no-such-service');
  assert.deepEqual(rows, []);
});

// ── response cache (T451) ───────────────────────────────────────────────────
import { db } from '../db/index.js';

await test('cacheKey on an api-category service: second call within TTL is a cache hit, fn NOT re-invoked, no extra usage row', async () => {
  svc({ name: 'svc-cache-api', category: 'api' });
  let calls = 0;
  const first = await callService('svc-cache-api', async () => { calls++; return { n: calls }; }, { cacheKey: 'k1' });
  assert.deepEqual(first, { n: 1 });
  assert.equal(serviceCallsToday('svc-cache-api'), 1);

  const second = await callService('svc-cache-api', async () => { calls++; return { n: calls }; }, { cacheKey: 'k1' });
  assert.deepEqual(second, { n: 1 }); // cached value, not a fresh call
  assert.equal(calls, 1); // fn was never invoked the second time
  assert.equal(serviceCallsToday('svc-cache-api'), 1); // no additional usage row
});

await test('cacheKey on an api-category service: a different cacheKey is its own cache miss', async () => {
  svc({ name: 'svc-cache-api-2', category: 'api' });
  let calls = 0;
  await callService('svc-cache-api-2', async () => { calls++; return calls; }, { cacheKey: 'a' });
  await callService('svc-cache-api-2', async () => { calls++; return calls; }, { cacheKey: 'b' });
  assert.equal(calls, 2);
});

await test('cacheKey expiry: a stale cached_at re-invokes fn and refreshes the row', async () => {
  svc({ name: 'svc-cache-ttl', category: 'api' });
  let calls = 0;
  await callService('svc-cache-ttl', async () => { calls++; return calls; }, { cacheKey: 'k' });
  assert.equal(calls, 1);

  // Backdate the cached row past the 5-minute TTL.
  const stale = new Date(Date.now() - 6 * 60_000).toISOString();
  db.prepare('UPDATE service_cache SET cached_at = ? WHERE service_name = ? AND cache_key = ?')
    .run(stale, 'svc-cache-ttl', 'k');

  const out = await callService('svc-cache-ttl', async () => { calls++; return calls; }, { cacheKey: 'k' });
  assert.equal(calls, 2); // re-fetched after TTL expiry
  assert.equal(out, 2);
});

await test('cacheKey is ignored for a non-api-category service (cli-tool): always calls fn, nothing cached', async () => {
  svc({ name: 'svc-cache-cli', category: 'cli-tool' });
  let calls = 0;
  await callService('svc-cache-cli', async () => { calls++; }, { cacheKey: 'k' });
  await callService('svc-cache-cli', async () => { calls++; }, { cacheKey: 'k' });
  assert.equal(calls, 2); // never short-circuited
  const row = db.prepare('SELECT * FROM service_cache WHERE service_name = ?').get('svc-cache-cli');
  assert.equal(row, undefined); // nothing written for a non-api service
});

await test('cacheKey is ignored for a non-api-category service (website-scrape): always calls fn, nothing cached', async () => {
  svc({ name: 'svc-cache-scrape', category: 'website-scrape' });
  let calls = 0;
  await callService('svc-cache-scrape', async () => { calls++; }, { cacheKey: 'k' });
  await callService('svc-cache-scrape', async () => { calls++; }, { cacheKey: 'k' });
  assert.equal(calls, 2);
});

// ── effectiveServiceTimeoutMs: override wins, else code default, else fallback (T465) ──
await test('effectiveServiceTimeoutMs: no def, no row → the caller fallback', async () => {
  assert.equal(effectiveServiceTimeoutMs('svc-timeout-unknown', 12_345), 12_345);
});

await test('effectiveServiceTimeoutMs: a code default (ServiceDefinition.timeoutMs) beats the fallback', async () => {
  svc({ name: 'svc-timeout-code', timeoutMs: 20_000 });
  assert.equal(effectiveServiceTimeoutMs('svc-timeout-code', 12_345), 20_000);
});

await test('effectiveServiceTimeoutMs: a dashboard override beats the code default', async () => {
  svc({ name: 'svc-timeout-override', timeoutMs: 20_000 });
  updateServiceLimits('svc-timeout-override', { rate_per_minute: null, daily_cap: null, monthly_cap: null, timeout_ms: 45_000 });
  assert.equal(effectiveServiceTimeoutMs('svc-timeout-override', 12_345), 45_000);
});

await test('effectiveServiceTimeoutMs: overridden but null timeout_ms falls back to the code default', async () => {
  svc({ name: 'svc-timeout-override-null', timeoutMs: 20_000 });
  // Override rate only — timeout_ms stays null, but limits_overridden flips true.
  updateServiceLimits('svc-timeout-override-null', { rate_per_minute: 5, daily_cap: null, monthly_cap: null, timeout_ms: null });
  assert.equal(effectiveServiceTimeoutMs('svc-timeout-override-null', 12_345), 20_000);
});

console.log(`\n${passed} services test(s) passed.`);
