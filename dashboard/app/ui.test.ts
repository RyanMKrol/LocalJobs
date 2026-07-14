// Pure-function coverage for the small helpers in ui.tsx that don't need React
// rendering: cronToEnglish, resolveMode, backFrom, fmtDuration, fmtRelative.
//
// Self-running (mirrors the src/*.test.ts convention): run directly with
//   npx tsx dashboard/app/ui.test.ts
//
// dashboard/ has no "type": "module" in its package.json, so top-level await
// resolves to esbuild's cjs output (unsupported) under `tsx` — wrap in an
// async main() instead, mirroring the other dashboard test suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cronToEnglish, resolveMode, backFrom, fmtDuration, fmtRelative, createPollController } from './ui.js';
import type { PollDocumentLike } from './ui.js';

async function main() {
  await test('cronToEnglish: daily at HH:MM', () => {
    assert.equal(cronToEnglish('30 9 * * *'), 'At 09:30, every day');
  });

  await test('cronToEnglish: monthly on a given day', () => {
    assert.equal(cronToEnglish('0 3 1 * *'), 'At 03:00 on the 1st of each month');
  });

  await test('cronToEnglish: weekly on a named day', () => {
    assert.equal(cronToEnglish('0 8 * * 1'), 'At 08:00 on Monday');
  });

  await test('cronToEnglish: every N minutes', () => {
    assert.equal(cronToEnglish('*/15 * * * *'), 'Every 15 minutes');
  });

  await test('cronToEnglish: every hour', () => {
    assert.equal(cronToEnglish('0 * * * *'), 'Every hour');
  });

  await test('cronToEnglish: unrecognised expression falls back to the raw string', () => {
    assert.equal(cronToEnglish('5 4 * * 1-5'), '5 4 * * 1-5');
  });

  await test('cronToEnglish: malformed expression (wrong field count) falls back unchanged', () => {
    assert.equal(cronToEnglish('not a cron'), 'not a cron');
  });

  await test('resolveMode: explicit dark/light choices force that mode regardless of OS', () => {
    assert.equal(resolveMode('dark', false), 'dark');
    assert.equal(resolveMode('light', true), 'light');
  });

  await test('resolveMode: "system" choice follows the OS preference', () => {
    assert.equal(resolveMode('system', true), 'dark');
    assert.equal(resolveMode('system', false), 'light');
  });

  await test('resolveMode: null (nothing stored yet) also follows the OS preference', () => {
    assert.equal(resolveMode(null, true), 'dark');
    assert.equal(resolveMode(null, false), 'light');
  });

  await test('backFrom: a recognised workflow-run path is used verbatim with its id as label', () => {
    assert.deepEqual(
      backFrom('/workflow-runs/wr_123', { href: '/runs', label: 'runs' }),
      { href: '/workflow-runs/wr_123', label: 'wr_123' },
    );
  });

  await test('backFrom: a recognised workflow/job path decodes its name as the label', () => {
    assert.deepEqual(
      backFrom('/workflows/my%20workflow', { href: '/x', label: 'fallback' }),
      { href: '/workflows/my%20workflow', label: 'my workflow' },
    );
  });

  await test('backFrom: missing/foreign/relative `from` falls back to the given default', () => {
    const fallback = { href: '/runs', label: 'runs' };
    assert.deepEqual(backFrom(null, fallback), fallback);
    assert.deepEqual(backFrom(undefined, fallback), fallback);
    assert.deepEqual(backFrom('not-a-path', fallback), fallback);
    assert.deepEqual(backFrom('/unknown/segment', fallback), fallback);
  });

  await test('fmtDuration: null renders as an em dash', () => {
    assert.equal(fmtDuration(null), '—');
  });

  await test('fmtDuration: sub-second durations render in ms', () => {
    assert.equal(fmtDuration(250), '250ms');
  });

  await test('fmtDuration: sub-minute durations render in seconds with one decimal', () => {
    assert.equal(fmtDuration(1500), '1.5s');
  });

  await test('fmtDuration: durations over a minute render as "Xm Ys"', () => {
    assert.equal(fmtDuration(90_000), '1m 30s');
  });

  await test('fmtRelative: null renders as an em dash', () => {
    assert.equal(fmtRelative(null), '—');
  });

  await test('fmtRelative: a timestamp a few seconds ago renders in seconds', () => {
    const t = new Date(Date.now() - 5_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    assert.match(fmtRelative(t), /^\d+s ago$/);
  });

  await test('fmtRelative: a timestamp an hour ago renders in hours', () => {
    const t = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    assert.match(fmtRelative(t), /^\d+h ago$/);
  });

  await test('createPollController: discards a stale response that resolves after a newer one', async () => {
    const deferreds: Array<(v: number) => void> = [];
    let calls = 0;
    const fn = () => new Promise<number>((resolve) => {
      calls += 1;
      deferreds.push(resolve);
    });
    const dataLog: number[] = [];
    const controller = createPollController<number>({
      fn,
      intervalMs: 1_000_000,
      setData: (d) => dataLog.push(d),
      setError: () => {},
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    // The constructor already fired tick #1 (in flight). Force a second tick (in flight) via refetch.
    controller.refetch();
    assert.equal(calls, 2);

    // Resolve the NEWER (2nd) call first.
    deferreds[1](200);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(dataLog, [200]);

    // Now resolve the OLDER (1st) call — it must be discarded, not overwrite the newer data.
    deferreds[0](100);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(dataLog, [200]);

    controller.stop();
  });

  await test('createPollController: pauses its interval while hidden and resumes+refetches on visible', async () => {
    let calls = 0;
    const fn = () => { calls += 1; return Promise.resolve(calls); };
    let visibilityState: 'visible' | 'hidden' = 'visible';
    let handler: (() => void) | null = null;
    const fakeDoc: PollDocumentLike = {
      get visibilityState() { return visibilityState; },
      addEventListener: (_type, cb) => { handler = cb; },
      removeEventListener: () => { handler = null; },
    };
    let intervalsStarted = 0;
    let intervalsStopped = 0;
    const dataLog: number[] = [];
    const controller = createPollController<number>({
      fn,
      intervalMs: 1_000,
      setData: (d) => dataLog.push(d),
      setError: () => {},
      doc: fakeDoc,
      setIntervalFn: () => { intervalsStarted += 1; return 1 as unknown as ReturnType<typeof setInterval>; },
      clearIntervalFn: () => { intervalsStopped += 1; },
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(intervalsStarted, 1);
    assert.deepEqual(dataLog, [1]);

    // Tab goes hidden — the interval must stop.
    visibilityState = 'hidden';
    handler?.();
    assert.equal(intervalsStopped, 1);
    assert.equal(calls, 1, 'no fetch should happen while hidden');

    // Tab becomes visible again — immediate refetch + interval restart.
    visibilityState = 'visible';
    handler?.();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls, 2);
    assert.equal(intervalsStarted, 2);
    assert.deepEqual(dataLog, [1, 2]);

    controller.stop();
  });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
