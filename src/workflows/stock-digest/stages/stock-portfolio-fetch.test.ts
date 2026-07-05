// stock-portfolio-fetch tests — hermetic: no live Trading212 API calls, no
// filesystem writes to the real job data dir. Uses a stub fetcher + stub writer
// + the scratch DB (npm test sets LOCALJOBS_DB). Mirrors stocks-sync's
// stocks-fetch.test.ts — same shape of stage.
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { getWorkItem, isWorkItemDone } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import {
  type NormalizedPosition,
  type Trading212Position,
} from '../../../services/trading212.service.js';
import { weekKey, weekLabel } from '../lib.js';
import { runStockPortfolioFetch, type RawPortfolioWriter } from './stock-portfolio-fetch.js';

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
  const write: RawPortfolioWriter = (positions) => {
    calls.push(positions);
  };
  return { write, calls };
}

const JOB = 'stock-portfolio-fetch';

// Each ledger-touching test needs its OWN distinct ISO week: the ledger row is
// keyed by weekKey, so two tests sharing the same `now` would collide.
let weekOffset = 0;
function freshNow(): Date {
  weekOffset += 1;
  return new Date(Date.UTC(2026, 0, 5 + weekOffset * 7)); // 2026-01-05 is a Monday; +N weeks
}

describe('runStockPortfolioFetch', () => {
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
          runStockPortfolioFetch(fakeCtx(), {
            fetchPortfolio: async () => [],
            writeRawPortfolio: () => {},
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
          runStockPortfolioFetch(fakeCtx(), {
            fetchPortfolio: async () => [],
            writeRawPortfolio: () => {},
          }),
        /TRADING212_API_SECRET_KEY/,
      );
    } finally {
      if (saved !== undefined) process.env.TRADING212_API_SECRET_KEY = saved;
    }
  });

  it('writes raw-portfolio.json without any isin/resolvedTicker fields', async () => {
    const now = freshNow();
    const pos = makePosition({ ticker: `RAW_${Date.now()}_EQ` });
    const { write, calls } = makeWriterSpy();

    await runStockPortfolioFetch(fakeCtx(), {
      now,
      fetchPortfolio: async () => [pos],
      writeRawPortfolio: write,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1);
    assert.equal(calls[0][0].ticker, pos.ticker);
    assert.equal('isin' in calls[0][0], false, 'raw positions carry no isin field yet');
    assert.equal('resolvedTicker' in calls[0][0], false, 'raw positions carry no resolvedTicker field yet');
  });

  it('records investCount/isaCount/totalFetched in ledger detail', async () => {
    const now = freshNow();
    process.env.TRADING212_ISA_API_KEY_ID = 'isa-key-id';
    process.env.TRADING212_ISA_API_SECRET_KEY = 'isa-secret-key';

    const investPos = makePosition({ ticker: `DETAIL_INVEST_${Date.now()}_EQ` });
    const isaPos = makePosition({ ticker: `DETAIL_ISA_${Date.now()}_EQ` });
    const { write } = makeWriterSpy();

    await runStockPortfolioFetch(fakeCtx(), {
      now,
      fetchPortfolio: async (keyId) => (keyId === 'isa-key-id' ? [isaPos] : [investPos]),
      writeRawPortfolio: write,
    });

    delete process.env.TRADING212_ISA_API_KEY_ID;
    delete process.env.TRADING212_ISA_API_SECRET_KEY;

    const row = getWorkItem(JOB, weekKey(now));
    assert.ok(row, 'ledger row should exist');
    const detail = JSON.parse(row!.detail!);
    assert.equal(detail.investCount, 1);
    assert.equal(detail.isaCount, 1);
    assert.equal(detail.totalFetched, 2);
    assert.equal(detail.name, `Positions fetched — ${weekLabel(now)}`);
    assert.equal(detail.format, 'json');
    assert.ok(typeof detail.path === 'string' && detail.path.endsWith('raw-portfolio.json'));
  });

  it('records a ledger row even when zero positions are fetched', async () => {
    const now = freshNow();
    const { write, calls } = makeWriterSpy();

    await runStockPortfolioFetch(fakeCtx(), {
      now,
      fetchPortfolio: async () => [],
      writeRawPortfolio: write,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 0);
    assert.ok(isWorkItemDone(JOB, weekKey(now), 1), 'a row is recorded even for an empty fetch');
    const row = getWorkItem(JOB, weekKey(now));
    const detail = JSON.parse(row!.detail!);
    assert.equal(detail.totalFetched, 0);
  });

  it('fetches only Invest positions when ISA credentials are unset', async () => {
    const now = freshNow();
    let fetchCalls = 0;
    const investPos = makePosition({ ticker: `NOISA_${Date.now()}_EQ` });
    const { write, calls } = makeWriterSpy();

    await runStockPortfolioFetch(fakeCtx(), {
      now,
      fetchPortfolio: async () => {
        fetchCalls++;
        return [investPos];
      },
      writeRawPortfolio: write,
    });

    assert.equal(fetchCalls, 1, 'no second fetch is made when ISA credentials are unset');
    assert.equal(calls[0].length, 1);
    assert.equal(calls[0][0].account, 'invest');
  });

  it('fetches both Invest and ISA positions when ISA credentials are set, tagged by account', async () => {
    const now = freshNow();
    process.env.TRADING212_ISA_API_KEY_ID = 'isa-key-id';
    process.env.TRADING212_ISA_API_SECRET_KEY = 'isa-secret-key';

    const investPos = makePosition({ ticker: `BOTH_INVEST_${Date.now()}_EQ` });
    const isaPos = makePosition({ ticker: `BOTH_ISA_${Date.now()}_EQ` });
    const { write, calls } = makeWriterSpy();

    await runStockPortfolioFetch(fakeCtx(), {
      now,
      fetchPortfolio: async (keyId) => (keyId === 'isa-key-id' ? [isaPos] : [investPos]),
      writeRawPortfolio: write,
    });

    delete process.env.TRADING212_ISA_API_KEY_ID;
    delete process.env.TRADING212_ISA_API_SECRET_KEY;

    assert.equal(calls[0].length, 2);
    const byAccount = Object.fromEntries(calls[0].map((p) => [p.account, p.ticker]));
    assert.equal(byAccount['invest'], investPos.ticker);
    assert.equal(byAccount['isa'], isaPos.ticker);
  });

  it('same ticker in both accounts is still counted twice in the combined fetch', async () => {
    const now = freshNow();
    process.env.TRADING212_ISA_API_KEY_ID = 'isa-key-id';
    process.env.TRADING212_ISA_API_SECRET_KEY = 'isa-secret-key';

    const sharedTicker = `SHARED_${Date.now()}_EQ`;
    const investPos = makePosition({ ticker: sharedTicker, averagePrice: 100, currentPrice: 110 });
    const isaPos = makePosition({ ticker: sharedTicker, averagePrice: 50, currentPrice: 60 });
    const { write, calls } = makeWriterSpy();

    await runStockPortfolioFetch(fakeCtx(), {
      now,
      fetchPortfolio: async (keyId) => (keyId === 'isa-key-id' ? [isaPos] : [investPos]),
      writeRawPortfolio: write,
    });

    delete process.env.TRADING212_ISA_API_KEY_ID;
    delete process.env.TRADING212_ISA_API_SECRET_KEY;

    assert.equal(calls[0].length, 2);
    const row = getWorkItem(JOB, weekKey(now));
    const detail = JSON.parse(row!.detail!);
    assert.equal(detail.totalFetched, 2);
  });
});
