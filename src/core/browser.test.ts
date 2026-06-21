// Tests for the shared headless-browser helper. We never launch a real browser:
// `launchPersistentBrowser` takes an injectable launcher, so we pass a fake that
// records its calls and can be made to throw — exercising the lock-clearing,
// option defaults, channel-passing, and channel→bundled-chromium fallback paths.
// `jitteredDelayMs` takes an injectable rng so its bounds are deterministic.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DESKTOP_CHROME_UA,
  PROFILE_LOCK_FILES,
  jitteredDelayMs,
  launchPersistentBrowser,
  type PersistentLauncher,
} from './browser.js';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.stack : e}`);
    process.exitCode = 1;
  }
}

/** A fake BrowserContext sentinel — we only assert identity, never call it. */
const FAKE_CTX = { __fake: true } as unknown as Awaited<ReturnType<PersistentLauncher>>;

/** Build a recording launcher; `failChannels` makes calls that pass a `channel` throw. */
function recorder(opts: { failChannels?: boolean } = {}) {
  const calls: Array<{ dir: string; options: Record<string, unknown> }> = [];
  const launch: PersistentLauncher = async (dir, options) => {
    calls.push({ dir, options });
    if (opts.failChannels && 'channel' in options) throw new Error('Chromium distribution "chrome" is not found');
    return FAKE_CTX;
  };
  return { calls, launch };
}

function tmpProfile(): string {
  return mkdtempSync(join(tmpdir(), 'lj-browser-test-'));
}

await test('passes the persistent profile dir + default base options to the launcher', async () => {
  const dir = tmpProfile();
  try {
    const { calls, launch } = recorder();
    const ctx = await launchPersistentBrowser({ profileDir: dir }, launch);
    assert.equal(ctx, FAKE_CTX);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dir, dir);
    const o = calls[0].options;
    assert.equal(o.headless, true);
    assert.equal(o.userAgent, DESKTOP_CHROME_UA);
    assert.equal(o.locale, 'en-GB');
    assert.deepEqual(o.viewport, { width: 1280, height: 1800 });
    assert.deepEqual(o.args, ['--disable-blink-features=AutomationControlled']);
    assert.ok(!('channel' in o), 'no channel given → none passed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('honours overrides and appends extra args after the anti-automation flag', async () => {
  const dir = tmpProfile();
  try {
    const { calls, launch } = recorder();
    await launchPersistentBrowser(
      { profileDir: dir, headless: false, userAgent: 'UA/1', locale: 'fr-FR', viewport: { width: 800, height: 600 }, args: ['--foo'] },
      launch,
    );
    const o = calls[0].options;
    assert.equal(o.headless, false);
    assert.equal(o.userAgent, 'UA/1');
    assert.equal(o.locale, 'fr-FR');
    assert.deepEqual(o.viewport, { width: 800, height: 600 });
    assert.deepEqual(o.args, ['--disable-blink-features=AutomationControlled', '--foo']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('passes channel through when given and the launch succeeds', async () => {
  const dir = tmpProfile();
  try {
    const { calls, launch } = recorder();
    await launchPersistentBrowser({ profileDir: dir, channel: 'chrome' }, launch);
    assert.equal(calls.length, 1, 'no fallback when the first launch works');
    assert.equal(calls[0].options.channel, 'chrome');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('clears stale Singleton* locks before launching', async () => {
  const dir = tmpProfile();
  try {
    for (const f of PROFILE_LOCK_FILES) writeFileSync(join(dir, f), 'stale');
    const { launch } = recorder();
    await launchPersistentBrowser({ profileDir: dir }, launch);
    for (const f of PROFILE_LOCK_FILES) {
      assert.ok(!existsSync(join(dir, f)), `${f} should have been removed`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('falls back to bundled chromium (no channel) when the real-Chrome launch fails', async () => {
  const dir = tmpProfile();
  try {
    const warnings: string[] = [];
    const { calls, launch } = recorder({ failChannels: true });
    const ctx = await launchPersistentBrowser(
      { profileDir: dir, channel: 'chrome', log: (m, lvl) => warnings.push(`${lvl}:${m}`) },
      launch,
    );
    assert.equal(ctx, FAKE_CTX);
    assert.equal(calls.length, 2, 'first call (channel) throws, second (no channel) retries');
    assert.equal(calls[0].options.channel, 'chrome');
    assert.ok(!('channel' in calls[1].options), 'fallback launch drops the channel');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^warn:.*bundled chromium/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('propagates the error when no channel was given (nothing to fall back to)', async () => {
  const dir = tmpProfile();
  try {
    const launch: PersistentLauncher = async () => { throw new Error('boom'); };
    await assert.rejects(() => launchPersistentBrowser({ profileDir: dir }, launch), /boom/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('jitteredDelayMs stays within [base, base+maxJitter] and rounds', () => {
  assert.equal(jitteredDelayMs(12_000, 6_000, () => 0), 12_000, 'rng=0 → base');
  assert.equal(jitteredDelayMs(12_000, 6_000, () => 1), 18_000, 'rng→1 → base+jitter');
  assert.equal(jitteredDelayMs(12_000, 6_000, () => 0.5), 15_000, 'mid');
  assert.equal(jitteredDelayMs(1_000, 100, () => 0.337), 1_034, 'rounded to integer ms');
  assert.equal(jitteredDelayMs(1_000, -50, () => 0.5), 1_000, 'negative jitter clamped to 0');
});

console.log(`\n  browser: ${passed} passed`);
