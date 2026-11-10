// stocks-snapshot tests — hermetic: no live Trading212 API calls, no filesystem
// writes to the real job data dir. Uses a stub raw-positions reader + stub writer +
// the scratch DB (npm test sets LOCALJOBS_DB).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { type NormalizedPosition } from '../../../services/trading212.service.js';
import {
  runStocksSnapshot,
  priceDiff,
  buildPortfolioMarkdown,
  dayKey,
  type PortfolioWriter,
  type NamedPositionsReader,
} from './stocks-snapshot.js';

function fakeCtx(): JobContext {
  return {
    log() {},
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

function makeNormalized(overrides: Partial<NormalizedPosition> = {}): NormalizedPosition {
  return {
    ticker: 'AAPL_US_EQ',
    account: 'invest',
    quantity: 10,
    averageBuyPrice: 100,
    currentPrice: 130,
    currentValue: 1300,
    ...overrides,
  };
}

function stubRaw(positions: NormalizedPosition[]): NamedPositionsReader {
  return () => positions;
}

function makeWriterSpy() {
  const calls: NormalizedPosition[][] = [];
  const write: PortfolioWriter = (positions) => {
    calls.push(positions);
  };
  return { write, calls };
}

// ---------------------------------------------------------------------------
// priceDiff
// ---------------------------------------------------------------------------

describe('priceDiff', () => {
  it('computes absolute + percentage gain', () => {
    const { absolute, percent } = priceDiff({
      ticker: 'X',
      account: 'invest',
      quantity: 1,
      averageBuyPrice: 100,
      currentPrice: 130,
      currentValue: 130,
    });
    assert.equal(absolute, 30);
    assert.equal(percent, 30);
  });

  it('computes a loss as negative', () => {
    const { absolute, percent } = priceDiff({
      ticker: 'X',
      account: 'invest',
      quantity: 1,
      averageBuyPrice: 100,
      currentPrice: 80,
      currentValue: 80,
    });
    assert.equal(absolute, -20);
    assert.equal(percent, -20);
  });
});

// ---------------------------------------------------------------------------
// buildPortfolioMarkdown
// ---------------------------------------------------------------------------

describe('buildPortfolioMarkdown', () => {
  it('renders one row per position with a diff column', () => {
    const md = buildPortfolioMarkdown([
      {
        ticker: 'AAPL_US_EQ',
        account: 'invest',
        quantity: 10,
        averageBuyPrice: 100,
        currentPrice: 130,
        currentValue: 1300,
      },
    ]);
    assert.match(md, /AAPL_US_EQ/);
    assert.match(md, /\+30\.00/);
    assert.match(md, /\+30\.00%/);
    assert.match(md, /Invest/);
  });

  it('shows a Company name column, populated when name is present and — when absent', () => {
    const md = buildPortfolioMarkdown([
      {
        ticker: 'AAPL_US_EQ',
        account: 'invest',
        quantity: 10,
        averageBuyPrice: 100,
        currentPrice: 130,
        currentValue: 1300,
        name: 'Apple Inc',
      },
      {
        ticker: 'UNKNOWN_EQ',
        account: 'invest',
        quantity: 1,
        averageBuyPrice: 1,
        currentPrice: 1,
        currentValue: 1,
      },
    ]);
    assert.match(md, /Company name/);
    assert.match(md, /Apple Inc/);
    assert.doesNotMatch(md, /Real ticker/);
    assert.match(md, /\| UNKNOWN_EQ \| — \|/);
  });

  it('visibly distinguishes the ISA account', () => {
    const md = buildPortfolioMarkdown([
      {
        ticker: 'VUSA_EQ',
        account: 'isa',
        quantity: 5,
        averageBuyPrice: 50,
        currentPrice: 55,
        currentValue: 275,
      },
    ]);
    assert.match(md, /ISA/);
  });
});

// ---------------------------------------------------------------------------
// dayKey
// ---------------------------------------------------------------------------

describe('dayKey', () => {
  it('formats a UTC date as YYYY-MM-DD', () => {
    assert.equal(dayKey(new Date('2026-07-04T23:59:59.000Z')), '2026-07-04');
  });

  it('uses the UTC calendar day, not the local one', () => {
    assert.equal(dayKey(new Date('2026-01-01T00:00:00.000Z')), '2026-01-01');
  });
});

// ---------------------------------------------------------------------------
// runStocksSnapshot
// ---------------------------------------------------------------------------

const JOB = 'stocks-snapshot';

describe('runStocksSnapshot', () => {
  it('writes portfolio.json + portfolio.md and writes no ledger row', async () => {
    const pos = makeNormalized({ ticker: `TEST_${Date.now()}_EQ` });
    const { write, calls } = makeWriterSpy();
    const now = new Date('2026-07-04T12:00:00.000Z');

    await runStocksSnapshot(fakeCtx(), {
      readNamedPositions: stubRaw([pos]),
      writePortfolio: write,
      now,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1);
    assert.equal(calls[0][0].ticker, pos.ticker);
    assert.equal(getWorkItem(JOB, dayKey(now)), undefined, 'the stage writes no ledger row');
  });

  it('returns positionCount and totalValue (and nothing else)', async () => {
    const pos = makeNormalized({ ticker: `DETAIL_${Date.now()}_EQ`, averageBuyPrice: 100, currentPrice: 130, currentValue: 1300 });
    const { write } = makeWriterSpy();
    const now = new Date('2026-07-05T08:00:00.000Z');

    const summary = await runStocksSnapshot(fakeCtx(), {
      readNamedPositions: stubRaw([pos]),
      writePortfolio: write,
      now,
    });

    assert.deepEqual(summary, { positionCount: 1, totalValue: 1300 });
    assert.equal(getWorkItem(JOB, dayKey(now)), undefined, 'the stage writes no ledger row');
  });

  it('handles empty position list gracefully (empty file written, zero summary, no ledger row)', async () => {
    const { write, calls } = makeWriterSpy();
    const now = new Date('2026-07-06T00:00:00.000Z');
    const summary = await runStocksSnapshot(fakeCtx(), {
      readNamedPositions: stubRaw([]),
      writePortfolio: write,
      now,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 0);
    assert.deepEqual(summary, { positionCount: 0, totalValue: 0 });
    assert.equal(getWorkItem(JOB, dayKey(now)), undefined, 'the stage writes no ledger row');
  });

  it('counts multiple positions in one summary and reports progress', async () => {
    const positions = [
      makeNormalized({ ticker: `MULTI1_${Date.now()}_EQ` }),
      makeNormalized({ ticker: `MULTI2_${Date.now()}_EQ` }),
    ];
    const progressCalls: number[] = [];
    const ctx: JobContext = {
      log() {},
      progress(pct) {
        progressCalls.push(pct);
      },
      selectedRoots: () => null,
      rootAllowed: () => true,
    };
    const now = new Date('2026-07-07T00:00:00.000Z');

    const { write, calls } = makeWriterSpy();
    const summary = await runStocksSnapshot(ctx, {
      readNamedPositions: stubRaw(positions),
      writePortfolio: write,
      now,
    });

    assert.equal(calls[0].length, 2);
    assert.equal(summary.positionCount, 2);
    assert.equal(summary.totalValue, 2600);
    assert.ok(progressCalls.length >= 2, 'progress called at least once per position');
    assert.equal(progressCalls[progressCalls.length - 1], 100, 'final progress is 100');
  });

  it('a same-day re-run rewrites the portfolio with the latest positions', async () => {
    const now = new Date('2026-07-08T09:00:00.000Z');
    const posA = makeNormalized({ ticker: `SAMEDAY_A_${Date.now()}_EQ` });
    const posB = makeNormalized({ ticker: `SAMEDAY_B_${Date.now()}_EQ` });
    const { write: write1, calls: calls1 } = makeWriterSpy();
    const { write: write2, calls: calls2 } = makeWriterSpy();

    const first = await runStocksSnapshot(fakeCtx(), {
      readNamedPositions: stubRaw([posA]),
      writePortfolio: write1,
      now,
    });
    const second = await runStocksSnapshot(fakeCtx(), {
      readNamedPositions: stubRaw([posA, posB]),
      writePortfolio: write2,
      now: new Date('2026-07-08T20:00:00.000Z'),
    });

    assert.equal(first.positionCount, 1);
    assert.equal(calls1[0].length, 1);
    assert.equal(second.positionCount, 2, 'the second run reports the latest positions');
    assert.equal(calls2.length, 1, 'the second run writes the portfolio again');
    assert.equal(calls2[0].length, 2);
    assert.equal(getWorkItem(JOB, dayKey(now)), undefined, 'neither run writes a ledger row');
  });

  it('runs on different days each write the portfolio and leave no ledger row for either day', async () => {
    const nowDay1 = new Date('2026-07-09T09:00:00.000Z');
    const nowDay2 = new Date('2026-07-10T09:00:00.000Z');
    const pos = makeNormalized({ ticker: `MULTIDAY_${Date.now()}_EQ` });
    const { write: write1, calls: calls1 } = makeWriterSpy();
    const { write: write2, calls: calls2 } = makeWriterSpy();

    const day1 = await runStocksSnapshot(fakeCtx(), {
      readNamedPositions: stubRaw([pos]),
      writePortfolio: write1,
      now: nowDay1,
    });
    const day2 = await runStocksSnapshot(fakeCtx(), {
      readNamedPositions: stubRaw([pos]),
      writePortfolio: write2,
      now: nowDay2,
    });

    assert.notEqual(dayKey(nowDay1), dayKey(nowDay2));
    assert.equal(calls1.length, 1);
    assert.equal(calls2.length, 1);
    assert.deepEqual(day1, { positionCount: 1, totalValue: 1300 });
    assert.deepEqual(day2, { positionCount: 1, totalValue: 1300 });
    assert.equal(getWorkItem(JOB, dayKey(nowDay1)), undefined);
    assert.equal(getWorkItem(JOB, dayKey(nowDay2)), undefined);
  });
});
