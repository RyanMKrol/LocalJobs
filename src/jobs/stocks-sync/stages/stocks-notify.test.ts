// stocks-notify tests — T300: the notify stage reads stocks-watch's
// fresh-breaches.json and sends exactly one push, or legitimately does
// nothing (a correct noop, unlike the check stage). Also proves the full
// idempotency chain holds ACROSS the two split stages.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JobContext } from '../../../core/types.js';
import { hasJobAdvancedAnyItem } from '../../../db/store.js';
import type { NormalizedPosition } from './stocks-snapshot.js';
import { runStocksWatch } from './stocks-watch.js';
import { runStocksNotify } from './stocks-notify.js';

function fakeCtx(): JobContext {
  return {
    log() {},
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

interface CapturedPush {
  title: string;
  body: string;
}

function capturingPush() {
  const sent: CapturedPush[] = [];
  const push = (async (title: string, body: string) => {
    sent.push({ title, body });
    return { ok: true };
  }) as unknown as typeof import('../../../core/notifier.js').push;
  return { sent, push };
}

const dir = mkdtempSync(join(tmpdir(), 'stocks-notify-'));
const portfolioPath = join(dir, 'portfolio.json');
const freshBreachesPath = join(dir, 'fresh-breaches.json');

function writePortfolio(positions: NormalizedPosition[]) {
  writeFileSync(portfolioPath, JSON.stringify(positions));
}

const AAPL = 'T300NOTIFY-AAPL';
const MSFT = 'T300NOTIFY-MSFT';
const TSLA = 'T300NOTIFY-TSLA';

function pos(ticker: string, avg: number, current: number): NormalizedPosition {
  return { ticker, account: 'invest', quantity: 1, averageBuyPrice: avg, currentPrice: current, currentValue: current };
}

// (a) no fresh breaches -> stocks-notify sends nothing and is a legitimate noop
// (hasJobAdvancedAnyItem is false for it, unlike stocks-watch, which is correct).
{
  const workflowRunId = 'wf-run-t300-notify-empty';
  process.env.LOCALJOBS_WORKFLOW_RUN_ID = workflowRunId;
  writePortfolio([pos(AAPL, 150, 155)]); // below threshold
  await runStocksWatch(fakeCtx(), { portfolioPath, freshBreachesPath });

  const { sent, push } = capturingPush();
  await runStocksNotify(fakeCtx(), { push, freshBreachesPath });
  delete process.env.LOCALJOBS_WORKFLOW_RUN_ID;

  assert.equal(sent.length, 0, 'no fresh breaches sends no push');
  assert.equal(
    hasJobAdvancedAnyItem(workflowRunId, 'stocks-notify'),
    false,
    'stocks-notify legitimately shows as noop when there is nothing to send',
  );
  console.log('  ✓ no fresh breaches: stocks-notify sends nothing and is a legitimate noop');
}

// (b) full idempotency chain across the two stages:
// fresh cross -> notify once; still above -> notify nothing; drop below -> reset;
// re-cross -> notify again.
{
  // Fresh breach.
  writePortfolio([pos(AAPL, 150, 198)]); // +32%
  await runStocksWatch(fakeCtx(), { portfolioPath, freshBreachesPath });
  {
    const { sent, push } = capturingPush();
    await runStocksNotify(fakeCtx(), { push, freshBreachesPath });
    assert.equal(sent.length, 1, 'fresh breach sends exactly one push');
    assert.match(sent[0].body, /AAPL/);
    assert.match(sent[0].body, /\+32%/);
  }

  // Still above threshold — already notified.
  writePortfolio([pos(AAPL, 150, 200)]);
  await runStocksWatch(fakeCtx(), { portfolioPath, freshBreachesPath });
  {
    const { sent, push } = capturingPush();
    await runStocksNotify(fakeCtx(), { push, freshBreachesPath });
    assert.equal(sent.length, 0, 'a sustained breach does not re-notify');
  }

  // Drop back below threshold — resets the notified-flag.
  writePortfolio([pos(AAPL, 150, 160)]); // ~+6.7%
  await runStocksWatch(fakeCtx(), { portfolioPath, freshBreachesPath });
  {
    const { sent, push } = capturingPush();
    await runStocksNotify(fakeCtx(), { push, freshBreachesPath });
    assert.equal(sent.length, 0, 'dropping below threshold sends no push');
  }

  // Later re-crossing — notifies again.
  writePortfolio([pos(AAPL, 150, 200)]); // re-crosses 30%
  await runStocksWatch(fakeCtx(), { portfolioPath, freshBreachesPath });
  {
    const { sent, push } = capturingPush();
    await runStocksNotify(fakeCtx(), { push, freshBreachesPath });
    assert.equal(sent.length, 1, 're-crossing after a reset notifies again');
    assert.match(sent[0].body, /AAPL/);
  }
  console.log('  ✓ full idempotency chain holds across stocks-watch + stocks-notify');
}

// (c) multiple positions freshly crossing >=30% in the same run send exactly ONE push
// listing all of them (not one push per position).
{
  writePortfolio([pos(MSFT, 100, 135), pos(TSLA, 200, 280)]); // +35%, +40%, never seen before
  await runStocksWatch(fakeCtx(), { portfolioPath, freshBreachesPath });
  const { sent, push } = capturingPush();
  await runStocksNotify(fakeCtx(), { push, freshBreachesPath });
  assert.equal(sent.length, 1, 'multiple fresh breaches in one run send exactly one push');
  assert.match(sent[0].body, /MSFT/);
  assert.match(sent[0].body, /TSLA/);
  console.log('  ✓ multiple simultaneous fresh breaches send exactly one combined push');
}

console.log('  ✓ stocks-notify tests passed');
