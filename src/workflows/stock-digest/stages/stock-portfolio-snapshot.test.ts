// stock-portfolio-snapshot tests — hermetic: no live Trading212 API calls, no
// filesystem writes to the real job data dir. Uses a stub raw-portfolio reader +
// stub writer + the scratch DB (npm test sets LOCALJOBS_DB). Proves this stage
// resolves ISIN/OpenFIGI tickers from stock-portfolio-fetch's raw-portfolio.json
// (T415 split), returns a summary of what it wrote, and writes no ledger row
// (portfolio.json is its declared output).
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { getWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import {
  normalizePosition,
  type NormalizedPosition,
  type Trading212Instrument,
  type Trading212Position,
} from '../../../services/trading212.service.js';
import { weekKey } from '../lib.js';
import { runStockPortfolioSnapshot, type PortfolioWriter, type RawPortfolioReader } from './stock-portfolio-snapshot.js';

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

function makeInstrument(overrides: Partial<Trading212Instrument> = {}): Trading212Instrument {
  return {
    ticker: 'YNDX_US_EQ',
    name: 'Nebius Group NV',
    isin: 'NL0009805522',
    currencyCode: 'USD',
    type: 'STOCK',
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

function rawReaderOf(positions: NormalizedPosition[]): RawPortfolioReader {
  return () => positions;
}

const JOB = 'stock-portfolio-snapshot';

// Each test gets its OWN distinct ISO week, so a "no ledger row for this week"
// check looks at a key no other test in this file has touched.
let weekOffset = 0;
function freshNow(): Date {
  weekOffset += 1;
  return new Date(Date.UTC(2026, 0, 5 + weekOffset * 7)); // 2026-01-05 is a Monday; +N weeks
}

describe('runStockPortfolioSnapshot', () => {
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
          runStockPortfolioSnapshot(fakeCtx(), {
            readRawPortfolio: rawReaderOf([]),
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
          runStockPortfolioSnapshot(fakeCtx(), {
            readRawPortfolio: rawReaderOf([]),
            writePortfolio: () => {},
          }),
        /TRADING212_API_SECRET_KEY/,
      );
    } finally {
      if (saved !== undefined) process.env.TRADING212_API_SECRET_KEY = saved;
    }
  });

  it('reads its raw positions from stock-portfolio-fetch and writes portfolio.json, with no ledger row', async () => {
    const now = freshNow();
    const pos = normalizePosition(makePosition({ ticker: `SELF_${Date.now()}_EQ` }));
    const { write, calls } = makeWriterSpy();

    const summary = await runStockPortfolioSnapshot(fakeCtx(), {
      now,
      readRawPortfolio: rawReaderOf([pos]),
      writePortfolio: write,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].ticker, pos.ticker);
    assert.equal(summary.positionCount, 1);
    assert.equal(getWorkItem(JOB, weekKey(now)), undefined, 'the stage writes no ledger row');
  });

  it('returns one summary counting every position', async () => {
    const now = freshNow();
    const positions = [
      normalizePosition(makePosition({ ticker: `MULTI1_${Date.now()}_EQ` })),
      normalizePosition(makePosition({ ticker: `MULTI2_${Date.now()}_EQ` })),
      normalizePosition(makePosition({ ticker: `MULTI3_${Date.now()}_EQ` })),
    ];
    const { write, calls } = makeWriterSpy();

    const summary = await runStockPortfolioSnapshot(fakeCtx(), {
      now,
      readRawPortfolio: rawReaderOf(positions),
      writePortfolio: write,
    });

    const expectedValue = positions.reduce((sum, p) => sum + p.currentValue, 0);
    assert.equal(calls[0].length, 3);
    assert.deepEqual(summary, { positionCount: 3, totalValue: expectedValue, resolvedCount: 0 });
  });

  it('writes no week-keyed ledger row of its own (downstream stages pass the week key as an explicit rootKey)', async () => {
    const now = freshNow();
    const { write, calls } = makeWriterSpy();
    const summary = await runStockPortfolioSnapshot(fakeCtx(), {
      now,
      readRawPortfolio: rawReaderOf([normalizePosition(makePosition())]),
      writePortfolio: write,
    });

    assert.equal(calls.length, 1);
    assert.equal(summary.positionCount, 1);
    assert.equal(getWorkItem(JOB, weekKey(now)), undefined);
  });

  it('resolves ISIN + real-world ticker end-to-end (mirrors stocks-sync T373), counted in the summary', async () => {
    const now = freshNow();
    const pos = normalizePosition(makePosition({ ticker: 'YNDX_US_EQ' }));
    const { write, calls } = makeWriterSpy();

    const summary = await runStockPortfolioSnapshot(fakeCtx(), {
      now,
      readRawPortfolio: rawReaderOf([pos]),
      fetchInstrumentsMetadata: async () => [makeInstrument()],
      resolveOpenFigiTickers: async (isins) => isins.map(() => 'NBIS'),
      writePortfolio: write,
    });

    assert.equal(calls[0][0].isin, 'NL0009805522');
    assert.equal(calls[0][0].resolvedTicker, 'NBIS');

    assert.equal(summary.resolvedCount, 1);
    assert.equal(summary.positionCount, 1);
  });

  it('handles empty raw-portfolio gracefully — writes the empty file, returns a zero summary, no ledger row', async () => {
    const now = freshNow();
    const { write, calls } = makeWriterSpy();
    const summary = await runStockPortfolioSnapshot(fakeCtx(), {
      now,
      readRawPortfolio: rawReaderOf([]),
      writePortfolio: write,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 0);
    assert.deepEqual(summary, { positionCount: 0, totalValue: 0, resolvedCount: 0 });
    assert.equal(getWorkItem(JOB, weekKey(now)), undefined);
  });
});
