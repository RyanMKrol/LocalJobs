// stocks-watch tests — breach detection + notify-once-per-episode ledger.
// Hermetic: injected push capture fn, synthetic portfolio.json, scratch DB
// (npm test points LOCALJOBS_DB at /tmp). Covers all scenarios from T290's
// Done-when: fresh breach notifies, sustained breach doesn't re-notify, a
// drop-then-recross notifies again, no breaches sends nothing, and multiple
// simultaneous fresh breaches send exactly ONE push listing all of them.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JobContext } from '../../../core/types.js';
import type { NormalizedPosition } from './stocks-snapshot.js';
import { runStocksWatch } from './stocks-watch.js';

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

const portfolioPath = join(mkdtempSync(join(tmpdir(), 'stocks-watch-')), 'portfolio.json');
function writePortfolio(positions: NormalizedPosition[]) {
  writeFileSync(portfolioPath, JSON.stringify(positions));
}

// Use distinct tickers so this test is independent of any other ledger rows.
const AAPL = 'T290AAPL';
const MSFT = 'T290MSFT';
const TSLA = 'T290TSLA';

function pos(ticker: string, avg: number, current: number): NormalizedPosition {
  return { ticker, quantity: 1, averageBuyPrice: avg, currentPrice: current, currentValue: current };
}

// (a) a fresh breach triggers exactly one push mentioning that ticker.
{
  const { sent, push } = capturingPush();
  writePortfolio([pos(AAPL, 150, 198)]); // +32%
  await runStocksWatch(fakeCtx(), { push, portfolioPath });
  assert.equal(sent.length, 1, 'fresh breach sends exactly one push');
  assert.match(sent[0].body, /AAPL/);
  assert.match(sent[0].body, /\+32%/);
  console.log('  ✓ fresh breach triggers one push mentioning the ticker');
}

// (b) already-notified breach that stays >=30% triggers no further push.
{
  const { sent, push } = capturingPush();
  writePortfolio([pos(AAPL, 150, 200)]); // still well above 30%, already notified
  await runStocksWatch(fakeCtx(), { push, portfolioPath });
  assert.equal(sent.length, 0, 'a sustained breach does not re-notify');
  console.log('  ✓ sustained breach above threshold sends no further push');
}

// (c) drop back under 30% clears the ledger row; a later re-cross notifies again.
{
  const { sent, push } = capturingPush();
  writePortfolio([pos(AAPL, 150, 160)]); // ~+6.7%, below threshold
  await runStocksWatch(fakeCtx(), { push, portfolioPath });
  assert.equal(sent.length, 0, 'dropping below threshold sends no push');

  const { sent: sent2, push: push2 } = capturingPush();
  writePortfolio([pos(AAPL, 150, 200)]); // re-crosses 30%
  await runStocksWatch(fakeCtx(), { push: push2, portfolioPath });
  assert.equal(sent2.length, 1, 're-crossing after a reset notifies again');
  assert.match(sent2[0].body, /AAPL/);
  console.log('  ✓ drop below threshold resets ledger; later re-cross notifies again');
}

// (d) no position >=30% sends zero pushes.
{
  const { sent, push } = capturingPush();
  writePortfolio([pos(MSFT, 100, 105), pos(TSLA, 200, 210)]);
  await runStocksWatch(fakeCtx(), { push, portfolioPath });
  assert.equal(sent.length, 0, 'no breaches sends zero pushes');
  console.log('  ✓ no breaches sends zero pushes');
}

// (e) multiple positions freshly crossing >=30% in the same run send exactly ONE push.
{
  const { sent, push } = capturingPush();
  writePortfolio([pos(MSFT, 100, 135), pos(TSLA, 200, 280)]); // +35%, +40%
  await runStocksWatch(fakeCtx(), { push, portfolioPath });
  assert.equal(sent.length, 1, 'multiple fresh breaches in one run send exactly one push');
  assert.match(sent[0].body, /MSFT/);
  assert.match(sent[0].body, /TSLA/);
  console.log('  ✓ multiple simultaneous fresh breaches send exactly one combined push');
}

console.log('  ✓ stocks-watch tests passed');
