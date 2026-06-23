// Tests for the shared mkdir-based repo lock (T136) — the same lock loop.sh uses to
// serialize git ops between the autonomous loop and the daemon. We drive it with an
// explicit lockDir (a temp dir) so we never touch the real repo lock.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRepoLock } from './repo-lock.js';

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

const dir = mkdtempSync(join(tmpdir(), 'localjobs-lock-'));

await test('acquire then release: creates the lock dir + pid file, then removes it', async () => {
  const lockDir = join(dir, 'a.lock');
  const release = await acquireRepoLock({ lockDir });
  assert.ok(existsSync(lockDir), 'lock dir exists while held');
  assert.equal(readFileSync(join(lockDir, 'pid'), 'utf8').trim(), String(process.pid));
  release();
  assert.equal(existsSync(lockDir), false, 'lock dir removed after release');
  release(); // idempotent — second call is a no-op
});

await test('two acquirers serialize: the second waits until the first releases', async () => {
  const lockDir = join(dir, 'b.lock');
  const order: string[] = [];
  const release1 = await acquireRepoLock({ lockDir });
  order.push('1-acquired');

  // Second acquire must BLOCK until release1() runs.
  const second = acquireRepoLock({ lockDir, pollMs: 10, timeoutMs: 5000 }).then((rel) => {
    order.push('2-acquired');
    return rel;
  });

  // Give the second a chance to (wrongly) acquire — it must not yet.
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(order, ['1-acquired'], 'second is still blocked while first holds the lock');

  release1();
  order.push('1-released');
  const release2 = await second;
  assert.deepEqual(order, ['1-acquired', '1-released', '2-acquired'], 'second only proceeds after first releases');
  release2();
});

await test('stale-pid reclaim: a lock owned by a dead PID is reclaimed', async () => {
  const lockDir = join(dir, 'c.lock');
  // Simulate a crashed holder: create the lock dir with a PID that cannot be alive.
  // 2147483647 (INT_MAX) is not a live process, so kill -0 fails → reclaimable.
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'pid'), '2147483647\n');

  const release = await acquireRepoLock({ lockDir, timeoutMs: 2000, pollMs: 10 });
  assert.equal(readFileSync(join(lockDir, 'pid'), 'utf8').trim(), String(process.pid), 'reclaimed by us');
  release();
});

await test('timeout: throws if a LIVE holder never releases', async () => {
  const lockDir = join(dir, 'd.lock');
  const release = await acquireRepoLock({ lockDir });
  await assert.rejects(
    () => acquireRepoLock({ lockDir, timeoutMs: 120, pollMs: 20 }),
    /could not acquire repo lock/,
  );
  release();
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n  repo-lock: ${passed} passed`);
