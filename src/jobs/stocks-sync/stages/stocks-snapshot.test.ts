// stocks-snapshot tests — hermetic: no live Trading212 API calls, no filesystem
// writes to the real job data dir. Uses a stub fetcher + stub writer + the scratch
// DB (npm test sets LOCALJOBS_DB).
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { isWorkItemDone } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import {
  runStocksSnapshot,
  normalizePosition,
  priceDiff,
  buildPortfolioMarkdown,
  type Trading212Position,
  type NormalizedPosition,
  type PortfolioWriter,
} from './stocks-snapshot.js';

function fakeCtx(): JobContext {
  return {
    log() {},
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

function makePosition(overrides: Partial<Trading212Position> = {}): Trading212Position {
  return {
    ticker: 'AAPL_US_EQ',
    quantity: 10,
    averagePrice: 100,
    currentPrice: 130,
    ppl: 300,
    fxPpl: 0,
    initialFillDate: '2026-01-01T00:00:00.000+00:00',
    frontend: 'IOS',
    maxBuy: 1000,
    maxSell: null,
    pieQuantity: 0,
    ...overrides,
  };
}

function makeWriterSpy() {
  const calls: NormalizedPosition[][] = [];
  const write: PortfolioWriter = (positions) => {
    calls.push(positions);
  };
  return { write, calls };
}

// ---------------------------------------------------------------------------
// normalizePosition
// ---------------------------------------------------------------------------

describe('normalizePosition', () => {
  it('maps Trading212 fields to the broker-agnostic shape', () => {
    const pos = makePosition({ ticker: 'MSFT_US_EQ', quantity: 5, averagePrice: 200, currentPrice: 250 });
    const normalized = normalizePosition(pos);
    assert.equal(normalized.ticker, 'MSFT_US_EQ');
    assert.equal(normalized.quantity, 5);
    assert.equal(normalized.averageBuyPrice, 200);
    assert.equal(normalized.currentPrice, 250);
    assert.equal(normalized.currentValue, 1250);
  });
});

// ---------------------------------------------------------------------------
// priceDiff
// ---------------------------------------------------------------------------

describe('priceDiff', () => {
  it('computes absolute + percentage gain', () => {
    const { absolute, percent } = priceDiff({
      ticker: 'X',
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
      { ticker: 'AAPL_US_EQ', quantity: 10, averageBuyPrice: 100, currentPrice: 130, currentValue: 1300 },
    ]);
    assert.match(md, /AAPL_US_EQ/);
    assert.match(md, /\+30\.00/);
    assert.match(md, /\+30\.00%/);
  });
});

// ---------------------------------------------------------------------------
// runStocksSnapshot
// ---------------------------------------------------------------------------

const JOB = 'stocks-snapshot';

describe('runStocksSnapshot', () => {
  beforeEach(() => {
    process.env.TRADING212_API_KEY_ID = 'test-key-id';
    process.env.TRADING212_API_SECRET_KEY = 'test-secret-key';
  });

  it('throws if TRADING212_API_KEY_ID is missing', async () => {
    const saved = process.env.TRADING212_API_KEY_ID;
    delete process.env.TRADING212_API_KEY_ID;
    try {
      await assert.rejects(
        () =>
          runStocksSnapshot(fakeCtx(), {
            fetchPortfolio: async () => [],
            writePortfolio: () => {},
          }),
        /TRADING212_API_KEY_ID/,
      );
    } finally {
      if (saved !== undefined) process.env.TRADING212_API_KEY_ID = saved;
    }
  });

  it('throws if TRADING212_API_SECRET_KEY is missing', async () => {
    const saved = process.env.TRADING212_API_SECRET_KEY;
    delete process.env.TRADING212_API_SECRET_KEY;
    try {
      await assert.rejects(
        () =>
          runStocksSnapshot(fakeCtx(), {
            fetchPortfolio: async () => [],
            writePortfolio: () => {},
          }),
        /TRADING212_API_SECRET_KEY/,
      );
    } finally {
      if (saved !== undefined) process.env.TRADING212_API_SECRET_KEY = saved;
    }
  });

  it('writes portfolio.json + portfolio.md and marks each ticker done', async () => {
    const pos = makePosition({ ticker: `TEST_${Date.now()}_EQ` });
    const { write, calls } = makeWriterSpy();

    await runStocksSnapshot(fakeCtx(), {
      fetchPortfolio: async () => [pos],
      writePortfolio: write,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1);
    assert.equal(calls[0][0].ticker, pos.ticker);
    assert.ok(isWorkItemDone(JOB, pos.ticker, 3), 'ticker should be marked done');
  });

  it('handles empty position list gracefully', async () => {
    const { write, calls } = makeWriterSpy();
    await runStocksSnapshot(fakeCtx(), {
      fetchPortfolio: async () => [],
      writePortfolio: write,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 0);
  });

  it('records multiple positions and reports progress', async () => {
    const positions = [
      makePosition({ ticker: `MULTI1_${Date.now()}_EQ` }),
      makePosition({ ticker: `MULTI2_${Date.now()}_EQ` }),
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

    const { write, calls } = makeWriterSpy();
    await runStocksSnapshot(ctx, {
      fetchPortfolio: async () => positions,
      writePortfolio: write,
    });

    assert.equal(calls[0].length, 2);
    for (const pos of positions) {
      assert.ok(isWorkItemDone(JOB, pos.ticker, 3), `ticker ${pos.ticker} should be marked done`);
    }
    assert.ok(progressCalls.length >= 2, 'progress called at least once per position');
    assert.equal(progressCalls[progressCalls.length - 1], 100, 'final progress is 100');
  });
});
