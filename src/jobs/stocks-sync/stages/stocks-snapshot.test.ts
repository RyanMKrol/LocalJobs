// stocks-snapshot tests — hermetic: no live Trading212 API calls, no filesystem
// writes to the real job data dir. Uses a stub fetcher + stub writer + the scratch
// DB (npm test sets LOCALJOBS_DB).
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import { getWorkItem, isWorkItemDone } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import {
  normalizePosition,
  positionKey,
  type NormalizedPosition,
  type Trading212Instrument,
  type Trading212Position,
} from '../../../services/trading212.service.js';
import { stocksSyncConfig } from '../config.js';
import {
  runStocksSnapshot,
  priceDiff,
  buildPortfolioMarkdown,
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
    assert.equal(normalized.account, 'invest');
  });

  it('tags a position with the given account', () => {
    const pos = makePosition({ ticker: 'VUSA_EQ' });
    const normalized = normalizePosition(pos, 'isa');
    assert.equal(normalized.account, 'isa');
  });
});

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
    assert.ok(isWorkItemDone(JOB, positionKey('invest', pos.ticker), 3), 'ticker should be marked done');
  });

  it('records currentPrice/averageBuyPrice/markdown in the ledger detail', async () => {
    const pos = makePosition({ ticker: `DETAIL_${Date.now()}_EQ`, averagePrice: 100, currentPrice: 130 });
    const { write } = makeWriterSpy();

    await runStocksSnapshot(fakeCtx(), {
      fetchPortfolio: async () => [pos],
      writePortfolio: write,
    });

    const row = getWorkItem(JOB, positionKey('invest', pos.ticker));
    assert.ok(row, 'ledger row should exist');
    const detail = JSON.parse(row!.detail!);
    assert.equal(detail.currentPrice, 130);
    assert.equal(detail.averageBuyPrice, 100);
    assert.equal(detail.markdown, stocksSyncConfig.portfolioMdPath);
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
      assert.ok(isWorkItemDone(JOB, positionKey('invest', pos.ticker), 3), `ticker ${pos.ticker} should be marked done`);
    }
    assert.ok(progressCalls.length >= 2, 'progress called at least once per position');
    assert.equal(progressCalls[progressCalls.length - 1], 100, 'final progress is 100');
  });

  it('fetches only Invest positions when ISA credentials are unset (unchanged behavior)', async () => {
    delete process.env.TRADING212_ISA_API_KEY_ID;
    delete process.env.TRADING212_ISA_API_SECRET_KEY;

    let fetchCalls = 0;
    const investPos = makePosition({ ticker: `NOISA_${Date.now()}_EQ` });
    const { write, calls } = makeWriterSpy();

    await runStocksSnapshot(fakeCtx(), {
      fetchPortfolio: async () => {
        fetchCalls++;
        return [investPos];
      },
      writePortfolio: write,
    });

    assert.equal(fetchCalls, 1, 'no second fetch is made when ISA credentials are unset');
    assert.equal(calls[0].length, 1);
    assert.equal(calls[0][0].account, 'invest');
  });

  it('fetches both Invest and ISA positions when ISA credentials are set, tagged by account', async () => {
    process.env.TRADING212_ISA_API_KEY_ID = 'isa-key-id';
    process.env.TRADING212_ISA_API_SECRET_KEY = 'isa-secret-key';

    const investPos = makePosition({ ticker: `BOTH_INVEST_${Date.now()}_EQ` });
    const isaPos = makePosition({ ticker: `BOTH_ISA_${Date.now()}_EQ` });
    const { write, calls } = makeWriterSpy();

    await runStocksSnapshot(fakeCtx(), {
      fetchPortfolio: async (keyId) => (keyId === 'isa-key-id' ? [isaPos] : [investPos]),
      writePortfolio: write,
    });

    delete process.env.TRADING212_ISA_API_KEY_ID;
    delete process.env.TRADING212_ISA_API_SECRET_KEY;

    assert.equal(calls[0].length, 2);
    const byAccount = Object.fromEntries(calls[0].map((p) => [p.account, p.ticker]));
    assert.equal(byAccount['invest'], investPos.ticker);
    assert.equal(byAccount['isa'], isaPos.ticker);
  });

  it('same ticker in both accounts produces two distinct, non-colliding ledger entries', async () => {
    process.env.TRADING212_ISA_API_KEY_ID = 'isa-key-id';
    process.env.TRADING212_ISA_API_SECRET_KEY = 'isa-secret-key';

    const sharedTicker = `SHARED_${Date.now()}_EQ`;
    const investPos = makePosition({ ticker: sharedTicker, averagePrice: 100, currentPrice: 110 });
    const isaPos = makePosition({ ticker: sharedTicker, averagePrice: 50, currentPrice: 60 });
    const { write } = makeWriterSpy();

    await runStocksSnapshot(fakeCtx(), {
      fetchPortfolio: async (keyId) => (keyId === 'isa-key-id' ? [isaPos] : [investPos]),
      writePortfolio: write,
    });

    delete process.env.TRADING212_ISA_API_KEY_ID;
    delete process.env.TRADING212_ISA_API_SECRET_KEY;

    assert.ok(isWorkItemDone(JOB, positionKey('invest', sharedTicker), 3));
    assert.ok(isWorkItemDone(JOB, positionKey('isa', sharedTicker), 3));
    assert.notEqual(positionKey('invest', sharedTicker), positionKey('isa', sharedTicker));
  });

  // -------------------------------------------------------------------------
  // ISIN + real-ticker resolution (T373)
  // -------------------------------------------------------------------------

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

  it('resolves ISIN + real-world ticker end-to-end', async () => {
    const pos = makePosition({ ticker: 'YNDX_US_EQ' });
    const { write, calls } = makeWriterSpy();
    let metadataCalls = 0;

    await runStocksSnapshot(fakeCtx(), {
      fetchPortfolio: async () => [pos],
      fetchInstrumentsMetadata: async () => {
        metadataCalls++;
        return [makeInstrument()];
      },
      resolveOpenFigiTickers: async (isins) => isins.map(() => 'NBIS'),
      writePortfolio: write,
    });

    assert.equal(metadataCalls, 1, 'instruments-metadata is fetched at most once per stage run');
    assert.equal(calls[0][0].isin, 'NL0009805522');
    assert.equal(calls[0][0].resolvedTicker, 'NBIS');
  });

  it('leaves isin/resolvedTicker undefined and logs a warn when the ticker is absent from instruments-metadata', async () => {
    const pos = makePosition({ ticker: 'UNKNOWN_TICKER_EQ' });
    const { write, calls } = makeWriterSpy();
    const logs: string[] = [];
    const ctx: JobContext = {
      log: (msg) => logs.push(msg),
      progress() {},
      selectedRoots: () => null,
      rootAllowed: () => true,
    };

    await runStocksSnapshot(ctx, {
      fetchPortfolio: async () => [pos],
      fetchInstrumentsMetadata: async () => [makeInstrument({ ticker: 'OTHER_TICKER_EQ' })],
      resolveOpenFigiTickers: async (isins) => isins.map(() => 'NBIS'),
      writePortfolio: write,
    });

    assert.equal(calls[0][0].isin, undefined);
    assert.equal(calls[0][0].resolvedTicker, undefined);
    assert.ok(
      logs.some((l) => l.startsWith('warn:') && l.includes('UNKNOWN_TICKER_EQ')),
      'should log a warn naming the unresolved ticker',
    );
  });

  it('leaves resolvedTicker undefined (but isin populated) on an OpenFIGI resolution miss', async () => {
    const pos = makePosition({ ticker: 'YNDX_US_EQ' });
    const { write, calls } = makeWriterSpy();
    const logs: string[] = [];
    const ctx: JobContext = {
      log: (msg) => logs.push(msg),
      progress() {},
      selectedRoots: () => null,
      rootAllowed: () => true,
    };

    await runStocksSnapshot(ctx, {
      fetchPortfolio: async () => [pos],
      fetchInstrumentsMetadata: async () => [makeInstrument()],
      resolveOpenFigiTickers: async (isins) => isins.map(() => null),
      writePortfolio: write,
    });

    assert.equal(calls[0][0].isin, 'NL0009805522');
    assert.equal(calls[0][0].resolvedTicker, undefined);
    assert.ok(
      logs.some((l) => l.startsWith('warn:') && l.includes('NL0009805522')),
      'should log a warn naming the unresolved ISIN',
    );
  });
});
