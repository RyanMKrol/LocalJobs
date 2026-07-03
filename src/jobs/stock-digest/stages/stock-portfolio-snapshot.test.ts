// stock-portfolio-snapshot tests — hermetic: no live Trading212 API calls, no
// filesystem writes to the real job data dir. Uses a stub fetcher + stub writer
// + the scratch DB (npm test sets LOCALJOBS_DB). Proves this stage is fully
// independent of stocks-sync (own credentials read, own ledger, own output file).
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { getWorkItem, isWorkItemDone } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import {
  positionKey,
  type NormalizedPosition,
  type Trading212Instrument,
  type Trading212Position,
} from '../../../services/trading212.service.js';
import { runStockPortfolioSnapshot, type PortfolioWriter } from './stock-portfolio-snapshot.js';

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

const JOB = 'stock-portfolio-snapshot';

describe('runStockPortfolioSnapshot', () => {
  beforeEach(() => {
    process.env.TRADING212_API_KEY_ID = 'test-key-id';
    process.env.TRADING212_API_SECRET_KEY = 'test-secret-key';
    delete process.env.TRADING212_ISA_API_KEY_ID;
    delete process.env.TRADING212_ISA_API_SECRET_KEY;
  });

  it('throws if TRADING212_API_KEY_ID is missing', async () => {
    const saved = process.env.TRADING212_API_KEY_ID;
    delete process.env.TRADING212_API_KEY_ID;
    try {
      await assert.rejects(
        () =>
          runStockPortfolioSnapshot(fakeCtx(), {
            fetchPortfolio: async () => [],
            writePortfolio: () => {},
          }),
        /TRADING212_API_KEY_ID/,
      );
    } finally {
      if (saved !== undefined) process.env.TRADING212_API_KEY_ID = saved;
    }
  });

  it('fetches its own snapshot and writes portfolio.json, marking each ticker done', async () => {
    const pos = makePosition({ ticker: `SELF_${Date.now()}_EQ` });
    const { write, calls } = makeWriterSpy();
    let fetchCalls = 0;

    await runStockPortfolioSnapshot(fakeCtx(), {
      fetchPortfolio: async () => {
        fetchCalls++;
        return [pos];
      },
      writePortfolio: write,
    });

    assert.equal(fetchCalls, 1, 'fetches directly from Trading212 — no read of another workflow\'s output');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].ticker, pos.ticker);
    assert.ok(isWorkItemDone(JOB, positionKey('invest', pos.ticker), 3));
  });

  it('resolves ISIN + real-world ticker end-to-end (mirrors stocks-sync T373)', async () => {
    const pos = makePosition({ ticker: 'YNDX_US_EQ' });
    const { write, calls } = makeWriterSpy();

    await runStockPortfolioSnapshot(fakeCtx(), {
      fetchPortfolio: async () => [pos],
      fetchInstrumentsMetadata: async () => [makeInstrument()],
      resolveOpenFigiTickers: async (isins) => isins.map(() => 'NBIS'),
      writePortfolio: write,
    });

    assert.equal(calls[0][0].isin, 'NL0009805522');
    assert.equal(calls[0][0].resolvedTicker, 'NBIS');

    const row = getWorkItem(JOB, positionKey('invest', 'YNDX_US_EQ'));
    const detail = JSON.parse(row!.detail!);
    assert.equal(detail.resolvedTicker, 'NBIS');
  });

  it('fetches both Invest and ISA positions when ISA credentials are set', async () => {
    process.env.TRADING212_ISA_API_KEY_ID = 'isa-key-id';
    process.env.TRADING212_ISA_API_SECRET_KEY = 'isa-secret-key';

    const investPos = makePosition({ ticker: `BOTH_INVEST_${Date.now()}_EQ` });
    const isaPos = makePosition({ ticker: `BOTH_ISA_${Date.now()}_EQ` });
    const { write, calls } = makeWriterSpy();

    await runStockPortfolioSnapshot(fakeCtx(), {
      fetchPortfolio: async (keyId) => (keyId === 'isa-key-id' ? [isaPos] : [investPos]),
      writePortfolio: write,
    });

    assert.equal(calls[0].length, 2);
    const byAccount = Object.fromEntries(calls[0].map((p) => [p.account, p.ticker]));
    assert.equal(byAccount['invest'], investPos.ticker);
    assert.equal(byAccount['isa'], isaPos.ticker);
  });

  it('handles empty position list gracefully', async () => {
    const { write, calls } = makeWriterSpy();
    await runStockPortfolioSnapshot(fakeCtx(), {
      fetchPortfolio: async () => [],
      writePortfolio: write,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 0);
  });
});
