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
  dayKey,
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

  it('writes portfolio.json + portfolio.md and records one combined ledger row', async () => {
    const pos = makePosition({ ticker: `TEST_${Date.now()}_EQ` });
    const { write, calls } = makeWriterSpy();
    const now = new Date('2026-07-04T12:00:00.000Z');

    await runStocksSnapshot(fakeCtx(), {
      fetchPortfolio: async () => [pos],
      writePortfolio: write,
      now,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1);
    assert.equal(calls[0][0].ticker, pos.ticker);
    assert.ok(isWorkItemDone(JOB, dayKey(now), 1), 'the day-keyed row should be marked done');
  });

  it('records positionCount/totalValue/resolvedCount/markdown in the collapsed ledger detail', async () => {
    const pos = makePosition({ ticker: `DETAIL_${Date.now()}_EQ`, averagePrice: 100, currentPrice: 130 });
    const { write } = makeWriterSpy();
    const now = new Date('2026-07-05T08:00:00.000Z');

    await runStocksSnapshot(fakeCtx(), {
      fetchPortfolio: async () => [pos],
      writePortfolio: write,
      now,
    });

    const row = getWorkItem(JOB, dayKey(now));
    assert.ok(row, 'ledger row should exist');
    const detail = JSON.parse(row!.detail!);
    assert.equal(detail.positionCount, 1);
    assert.equal(detail.totalValue, 1300);
    assert.equal(detail.resolvedCount, 0);
    assert.equal(detail.markdown, stocksSyncConfig.portfolioMdPath);
    assert.equal(detail.name, `Portfolio snapshot — ${dayKey(now)}`);
  });

  it('handles empty position list gracefully (no ledger row)', async () => {
    const { write, calls } = makeWriterSpy();
    const now = new Date('2026-07-06T00:00:00.000Z');
    await runStocksSnapshot(fakeCtx(), {
      fetchPortfolio: async () => [],
      writePortfolio: write,
      now,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 0);
    assert.ok(!isWorkItemDone(JOB, dayKey(now), 1), 'no ledger row for an empty portfolio');
  });

  it('records multiple positions in one row and reports progress', async () => {
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
    const now = new Date('2026-07-07T00:00:00.000Z');

    const { write, calls } = makeWriterSpy();
    await runStocksSnapshot(ctx, {
      fetchPortfolio: async () => positions,
      writePortfolio: write,
      now,
    });

    assert.equal(calls[0].length, 2);
    const row = getWorkItem(JOB, dayKey(now));
    assert.ok(row, 'combined ledger row should exist');
    const detail = JSON.parse(row!.detail!);
    assert.equal(detail.positionCount, 2);
    assert.ok(progressCalls.length >= 2, 'progress called at least once per position');
    assert.equal(progressCalls[progressCalls.length - 1], 100, 'final progress is 100');
  });

  it('a same-day re-run overwrites the row rather than duplicating it', async () => {
    const now = new Date('2026-07-08T09:00:00.000Z');
    const posA = makePosition({ ticker: `SAMEDAY_A_${Date.now()}_EQ` });
    const posB = makePosition({ ticker: `SAMEDAY_B_${Date.now()}_EQ` });
    const { write: write1 } = makeWriterSpy();
    const { write: write2 } = makeWriterSpy();

    await runStocksSnapshot(fakeCtx(), {
      fetchPortfolio: async () => [posA],
      writePortfolio: write1,
      now,
    });
    await runStocksSnapshot(fakeCtx(), {
      fetchPortfolio: async () => [posA, posB],
      writePortfolio: write2,
      now: new Date('2026-07-08T20:00:00.000Z'),
    });

    const row = getWorkItem(JOB, dayKey(now));
    assert.ok(row, 'ledger row should exist');
    const detail = JSON.parse(row!.detail!);
    assert.equal(detail.positionCount, 2, 'the second run overwrote the row with the latest detail');
  });

  it('runs on different days produce two distinct rows', async () => {
    const nowDay1 = new Date('2026-07-09T09:00:00.000Z');
    const nowDay2 = new Date('2026-07-10T09:00:00.000Z');
    const pos = makePosition({ ticker: `MULTIDAY_${Date.now()}_EQ` });
    const { write: write1 } = makeWriterSpy();
    const { write: write2 } = makeWriterSpy();

    await runStocksSnapshot(fakeCtx(), {
      fetchPortfolio: async () => [pos],
      writePortfolio: write1,
      now: nowDay1,
    });
    await runStocksSnapshot(fakeCtx(), {
      fetchPortfolio: async () => [pos],
      writePortfolio: write2,
      now: nowDay2,
    });

    assert.ok(isWorkItemDone(JOB, dayKey(nowDay1), 1));
    assert.ok(isWorkItemDone(JOB, dayKey(nowDay2), 1));
    assert.notEqual(dayKey(nowDay1), dayKey(nowDay2));
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

  it('same ticker in both accounts is still counted twice in the combined snapshot', async () => {
    process.env.TRADING212_ISA_API_KEY_ID = 'isa-key-id';
    process.env.TRADING212_ISA_API_SECRET_KEY = 'isa-secret-key';

    const sharedTicker = `SHARED_${Date.now()}_EQ`;
    const investPos = makePosition({ ticker: sharedTicker, averagePrice: 100, currentPrice: 110 });
    const isaPos = makePosition({ ticker: sharedTicker, averagePrice: 50, currentPrice: 60 });
    const { write, calls } = makeWriterSpy();
    const now = new Date('2026-07-11T09:00:00.000Z');

    await runStocksSnapshot(fakeCtx(), {
      fetchPortfolio: async (keyId) => (keyId === 'isa-key-id' ? [isaPos] : [investPos]),
      writePortfolio: write,
      now,
    });

    delete process.env.TRADING212_ISA_API_KEY_ID;
    delete process.env.TRADING212_ISA_API_SECRET_KEY;

    assert.equal(calls[0].length, 2);
    assert.notEqual(positionKey('invest', sharedTicker), positionKey('isa', sharedTicker));
    const row = getWorkItem(JOB, dayKey(now));
    const detail = JSON.parse(row!.detail!);
    assert.equal(detail.positionCount, 2);
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

  it('resolves ISIN + real-world ticker end-to-end and records resolvedCount', async () => {
    const pos = makePosition({ ticker: 'YNDX_US_EQ' });
    const { write, calls } = makeWriterSpy();
    let metadataCalls = 0;
    const now = new Date('2026-07-12T09:00:00.000Z');

    await runStocksSnapshot(fakeCtx(), {
      fetchPortfolio: async () => [pos],
      fetchInstrumentsMetadata: async () => {
        metadataCalls++;
        return [makeInstrument()];
      },
      resolveOpenFigiTickers: async (isins) => isins.map(() => 'NBIS'),
      writePortfolio: write,
      now,
    });

    assert.equal(metadataCalls, 1, 'instruments-metadata is fetched at most once per stage run');
    assert.equal(calls[0][0].isin, 'NL0009805522');
    assert.equal(calls[0][0].resolvedTicker, 'NBIS');
    const row = getWorkItem(JOB, dayKey(now));
    const detail = JSON.parse(row!.detail!);
    assert.equal(detail.resolvedCount, 1);
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
