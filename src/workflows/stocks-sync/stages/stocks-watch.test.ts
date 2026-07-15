// stocks-watch (check stage) tests — T300: reproduces the exact noop-detection
// scenario the framework's hasJobAdvancedAnyItem evaluates, confirming the
// check stage is NEVER misclassified as noop even when nothing breaches, by
// recording an unconditional per-position ledger write every run.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JobContext } from '../../../core/types.js';
import { getWorkItem, hasJobAdvancedAnyItem, markWorkItem } from '../../../db/store.js';
import { positionKey, type NormalizedPosition, type Trading212Account } from '../../../services/trading212.service.js';
import { runStocksWatch, WATCH_JOB } from './stocks-watch.js';

// Since T528, stocks-watch no longer marks the ::notified episode row itself —
// that's stocks-notify's job, after a verified-ok push. These tests exercise
// stocks-watch in isolation, so they simulate "stocks-notify already ran
// successfully for this breach" by marking the row directly, mirroring what
// stocks-notify.ts does on a verified push.
function simulateNotified(account: Trading212Account, ticker: string) {
  markWorkItem(WATCH_JOB, `${positionKey(account, ticker)}::notified`, 'success', {
    detail: { name: `${ticker} — notified breach (simulated)`, ticker, account },
  });
}

function fakeCtx(): JobContext {
  return {
    log() {},
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

const dir = mkdtempSync(join(tmpdir(), 'stocks-watch-'));
const portfolioPath = join(dir, 'portfolio.json');
const freshBreachesPath = join(dir, 'fresh-breaches.json');

function writePortfolio(positions: NormalizedPosition[]) {
  writeFileSync(portfolioPath, JSON.stringify(positions));
}

function readFreshBreaches(): Array<{ ticker: string }> {
  return JSON.parse(readFileSync(freshBreachesPath, 'utf-8'));
}

// Use distinct tickers so this test is independent of any other ledger rows.
const MSFT = 'T300MSFT';
const TSLA = 'T300TSLA';
const GOOG = 'T300GOOG';
const AMZN = 'T300AMZN';

function pos(
  ticker: string,
  avg: number,
  current: number,
  account: 'invest' | 'isa' = 'invest',
): NormalizedPosition {
  return { ticker, account, quantity: 1, averageBuyPrice: avg, currentPrice: current, currentValue: current };
}

// (a) a run with NO position breaching still records ledger activity for
// every checked position — hasJobAdvancedAnyItem must return true.
{
  const workflowRunId = 'wf-run-t300-no-breach';
  process.env.LOCALJOBS_WORKFLOW_RUN_ID = workflowRunId;
  writePortfolio([pos(MSFT, 100, 105), pos(TSLA, 200, 210)]);
  await runStocksWatch(fakeCtx(), { portfolioPath, freshBreachesPath });
  delete process.env.LOCALJOBS_WORKFLOW_RUN_ID;

  assert.equal(
    hasJobAdvancedAnyItem(workflowRunId, WATCH_JOB),
    true,
    'stocks-watch must record ledger activity even when nothing breaches, so it is never misclassified as noop',
  );
  assert.deepEqual(readFreshBreaches(), [], 'no breaches writes an empty fresh-breaches.json');

  const checkRow = getWorkItem(WATCH_JOB, positionKey('invest', MSFT));
  const checkDetail = JSON.parse(checkRow?.detail ?? '{}');
  assert.equal(checkDetail.name, '[invest] T300MSFT', 'per-run check ledger row detail carries a name label, not blank');
  assert.equal(checkDetail.ticker, MSFT, 'per-run check ledger row detail carries the ticker');

  console.log('  ✓ no-breach run still advances ledger items (never misclassified as noop)');
  console.log('  ✓ per-run check ledger row detail is labeled with name/ticker (not blank)');
}

// (b) a fresh breach is recorded in fresh-breaches.json for stocks-notify to consume.
// T528: stocks-watch itself must NOT write the ::notified episode row anymore —
// that only happens in stocks-notify, after a verified-ok push.
{
  writePortfolio([pos(MSFT, 100, 135)]); // +35%
  await runStocksWatch(fakeCtx(), { portfolioPath, freshBreachesPath });
  const breaches = readFreshBreaches();
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].ticker, MSFT);

  const notifiedRow = getWorkItem(WATCH_JOB, `${positionKey('invest', MSFT)}::notified`);
  assert.equal(
    notifiedRow,
    undefined,
    'stocks-watch must not mark the ::notified episode row itself — only stocks-notify does, after a verified push',
  );
  console.log('  ✓ fresh breach is written to fresh-breaches.json; ::notified row is NOT written by stocks-watch');
}

// (c) staying above threshold (already notified) does not re-appear in fresh-breaches.json.
{
  simulateNotified('invest', MSFT); // stocks-notify already delivered this breach
  writePortfolio([pos(MSFT, 100, 140)]); // still well above 30%, already notified
  await runStocksWatch(fakeCtx(), { portfolioPath, freshBreachesPath });
  assert.deepEqual(readFreshBreaches(), [], 'a sustained breach is not re-reported as fresh');
  console.log('  ✓ sustained breach above threshold is not re-reported as fresh');
}

// (d) dropping back under 30% resets the notified-flag; a later re-cross is fresh again.
{
  writePortfolio([pos(MSFT, 100, 106)]); // ~+6%, below threshold
  await runStocksWatch(fakeCtx(), { portfolioPath, freshBreachesPath });
  assert.deepEqual(readFreshBreaches(), [], 'dropping below threshold reports no fresh breach');

  writePortfolio([pos(MSFT, 100, 140)]); // re-crosses 30%
  await runStocksWatch(fakeCtx(), { portfolioPath, freshBreachesPath });
  const breaches = readFreshBreaches();
  assert.equal(breaches.length, 1, 're-crossing after a reset is reported as fresh again');
  assert.equal(breaches[0].ticker, MSFT);
  console.log('  ✓ drop below threshold resets notified-flag; later re-cross is fresh again');
}

// (e) multiple positions freshly crossing >=30% in the same run are all included.
{
  writePortfolio([pos(GOOG, 100, 135), pos(AMZN, 200, 280)]); // +35%, +40%, both never seen before
  await runStocksWatch(fakeCtx(), { portfolioPath, freshBreachesPath });
  const breaches = readFreshBreaches();
  assert.equal(breaches.length, 2, 'multiple simultaneous fresh breaches are all included');
  const tickers = breaches.map((b) => b.ticker).sort();
  assert.deepEqual(tickers, [GOOG, AMZN].sort());
  console.log('  ✓ multiple simultaneous fresh breaches are all recorded');
}

// (f) T301 — the SAME ticker held in both Invest and ISA accounts must not
// collide on the ledger: each account's breach state is tracked independently.
{
  const SHARED = 'T301SHARED';
  writePortfolio([pos(SHARED, 100, 135, 'invest'), pos(SHARED, 100, 105, 'isa')]);
  await runStocksWatch(fakeCtx(), { portfolioPath, freshBreachesPath });
  const breaches = readFreshBreaches() as Array<{ ticker: string; account: string }>;
  assert.equal(breaches.length, 1, 'only the Invest leg breaches; the ISA leg does not');
  assert.equal(breaches[0].ticker, SHARED);
  assert.equal(breaches[0].account, 'invest');
  simulateNotified('invest', SHARED); // stocks-notify already delivered the Invest leg's breach

  // Now the ISA leg also breaches — it must be reported as its OWN fresh
  // breach, not suppressed by the Invest leg already being notified.
  writePortfolio([pos(SHARED, 100, 140, 'invest'), pos(SHARED, 100, 145, 'isa')]);
  await runStocksWatch(fakeCtx(), { portfolioPath, freshBreachesPath });
  const breaches2 = readFreshBreaches() as Array<{ ticker: string; account: string }>;
  assert.equal(breaches2.length, 1, 'the invest leg is already notified; only the newly-breaching ISA leg is fresh');
  assert.equal(breaches2[0].account, 'isa');
  console.log('  ✓ same ticker in both accounts tracked as distinct, non-colliding ledger entries');
}

// (g) T575 — the breach threshold reads from STOCKS_WATCH_BREACH_PCT (default
// 30 when unset/invalid), and every breach computation follows it.
{
  const CUSTOM = 'T575CUSTOM';

  // Default (env unset): a +20% gain does NOT breach the default 30% bar.
  delete process.env.STOCKS_WATCH_BREACH_PCT;
  writePortfolio([pos(CUSTOM, 100, 120)]); // +20%
  await runStocksWatch(fakeCtx(), { portfolioPath, freshBreachesPath });
  assert.deepEqual(readFreshBreaches(), [], 'default threshold (30%) is not crossed by a +20% gain');

  // Lower the threshold to 15% via env — the same +20% gain now breaches.
  process.env.STOCKS_WATCH_BREACH_PCT = '15';
  await runStocksWatch(fakeCtx(), { portfolioPath, freshBreachesPath });
  const breaches = readFreshBreaches();
  assert.equal(breaches.length, 1, 'a lowered STOCKS_WATCH_BREACH_PCT is honoured by breach detection');
  assert.equal(breaches[0].ticker, CUSTOM);
  delete process.env.STOCKS_WATCH_BREACH_PCT;

  console.log('  ✓ STOCKS_WATCH_BREACH_PCT overrides the breach threshold; defaults to 30 when unset');
}

// (h) an invalid/non-positive env value falls back to the default 30%.
{
  const INVALID = 'T575INVALID';
  for (const bad of ['not-a-number', '0', '-10']) {
    process.env.STOCKS_WATCH_BREACH_PCT = bad;
    writePortfolio([pos(INVALID, 100, 120)]); // +20% — should NOT breach under the default 30%
    await runStocksWatch(fakeCtx(), { portfolioPath, freshBreachesPath });
    assert.deepEqual(readFreshBreaches(), [], `invalid STOCKS_WATCH_BREACH_PCT=${bad} falls back to the 30% default`);
  }
  delete process.env.STOCKS_WATCH_BREACH_PCT;
  console.log('  ✓ invalid/non-positive STOCKS_WATCH_BREACH_PCT falls back to the 30% default');
}

console.log('  ✓ stocks-watch tests passed');
