// stock-sector-lookup tests — hermetic: no live Finnhub calls (an injected fetchProfile
// stub stands in). Covers: portfolio/sector-map reads, per-ticker idempotency via the
// work_items ledger (already-resolved tickers are skipped), missing API key soft-skip,
// missing portfolio soft-skip, and the written sectors.json shape.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isWorkItemDone } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import {
  runStockSectorLookup,
  readPortfolio,
  readSectorMap,
  toFinnhubSymbol,
  fetchFinnhubProfile,
  type ProfileFetcher,
} from './stock-sector-lookup.js';
import type { NormalizedPosition } from '../../../services/trading212.service.js';

function fakeCtx(): JobContext {
  return {
    log() {},
    progress() {},
    selectedRoots: () => null,
    rootAllowed: () => true,
  };
}

function pos(overrides: Partial<NormalizedPosition> = {}): NormalizedPosition {
  return {
    ticker: 'AAPL',
    quantity: 10,
    averageBuyPrice: 100,
    currentPrice: 120,
    currentValue: 1200,
    account: 'invest',
    ...overrides,
  };
}

const JOB = 'stock-sector-lookup';

describe('toFinnhubSymbol', () => {
  it('strips the trailing _EQ and market-code suffix', () => {
    assert.equal(toFinnhubSymbol('AMD_US_EQ'), 'AMD');
    assert.equal(toFinnhubSymbol('MU_US_EQ'), 'MU');
  });

  it('leaves a ticker with no market code (LSE-primary instruments) unchanged besides _EQ', () => {
    assert.equal(toFinnhubSymbol('VUSA_EQ'), 'VUSA');
  });

  it('does not mistake a class-share underscore for a market code (known residual limitation)', () => {
    // BRK_B_US_EQ (Berkshire class B): stripping _EQ then a trailing 2-letter
    // market code (_US) correctly leaves BRK_B — but this is still not Finnhub's
    // exact expected form for a class-share ticker (likely BRK.B or BRK-B).
    // Documented limitation, not a silent bug: every other held ticker is fully
    // fixed by this transform, and BRK_B is a strict improvement over the
    // pre-fix 100%-broken state (raw ticker sent verbatim).
    assert.equal(toFinnhubSymbol('BRK_B_US_EQ'), 'BRK_B');
  });
});

describe('fetchFinnhubProfile', () => {
  it('requests Finnhub with the translated symbol, not the raw Trading212 ticker', async () => {
    let requestedUrl = '';
    const originalFetch = global.fetch;
    global.fetch = (async (url: string) => {
      requestedUrl = String(url);
      return { ok: true, json: async () => ({ finnhubIndustry: 'Semiconductors' }) } as Response;
    }) as typeof fetch;
    try {
      await fetchFinnhubProfile('AMD_US_EQ', 'test-key');
    } finally {
      global.fetch = originalFetch;
    }
    const symbolParam = new URL(requestedUrl).searchParams.get('symbol');
    assert.equal(symbolParam, 'AMD');
  });
});

describe('readSectorMap', () => {
  it('returns an empty object when the file does not exist', () => {
    assert.deepEqual(readSectorMap('/nonexistent/sectors.json'), {});
  });

  it('returns an empty object on malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-sector-'));
    const p = join(dir, 'sectors.json');
    writeFileSync(p, 'not json');
    assert.deepEqual(readSectorMap(p), {});
  });
});

describe('runStockSectorLookup', () => {
  it('soft-skips with no crash when the portfolio file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-sector-'));
    let fetchCalled = false;
    const fetchProfile: ProfileFetcher = async () => {
      fetchCalled = true;
      return { finnhubIndustry: 'Technology' };
    };
    await runStockSectorLookup(fakeCtx(), {
      portfolioPath: join(dir, 'nope.json'),
      outPath: join(dir, 'sectors.json'),
      apiKey: 'key',
      fetchProfile,
    });
    assert.equal(fetchCalled, false);
    assert.equal(existsSync(join(dir, 'sectors.json')), false);
  });

  it('soft-skips with no crash when FINNHUB_API_KEY is unset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-sector-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(portfolioPath, JSON.stringify([pos()]));
    let fetchCalled = false;
    const fetchProfile: ProfileFetcher = async () => {
      fetchCalled = true;
      return { finnhubIndustry: 'Technology' };
    };
    await runStockSectorLookup(fakeCtx(), {
      portfolioPath,
      outPath: join(dir, 'sectors.json'),
      apiKey: '',
      fetchProfile,
    });
    assert.equal(fetchCalled, false);
  });

  it('looks up each distinct ticker and writes sectors.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-sector-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(
      portfolioPath,
      JSON.stringify([pos({ ticker: 'AAPL' }), pos({ ticker: 'MSFT', account: 'isa' })]),
    );
    const outPath = join(dir, 'sectors.json');
    const calls: string[] = [];
    const fetchProfile: ProfileFetcher = async (ticker) => {
      calls.push(ticker);
      return { finnhubIndustry: ticker === 'AAPL' ? 'Technology' : 'Software' };
    };

    await runStockSectorLookup(fakeCtx(), { portfolioPath, outPath, apiKey: 'key', fetchProfile });

    assert.deepEqual(calls.sort(), ['AAPL', 'MSFT']);
    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.deepEqual(written, { AAPL: 'Technology', MSFT: 'Software' });
    assert.equal(isWorkItemDone(JOB, 'AAPL', 1), true);
    assert.equal(isWorkItemDone(JOB, 'MSFT', 1), true);
  });

  it('dedupes the same ticker held across multiple accounts into one lookup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-sector-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(
      portfolioPath,
      JSON.stringify([pos({ ticker: 'DEDUPE1', account: 'invest' }), pos({ ticker: 'DEDUPE1', account: 'isa' })]),
    );
    const outPath = join(dir, 'sectors.json');
    const calls: string[] = [];
    const fetchProfile: ProfileFetcher = async (ticker) => {
      calls.push(ticker);
      return { finnhubIndustry: 'Technology' };
    };

    await runStockSectorLookup(fakeCtx(), { portfolioPath, outPath, apiKey: 'key', fetchProfile });

    assert.deepEqual(calls, ['DEDUPE1']);
  });

  it('is idempotent per ticker — an already-resolved ticker is not re-looked-up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-sector-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(portfolioPath, JSON.stringify([pos({ ticker: 'IDEMPOTENT1' })]));
    const outPath = join(dir, 'sectors.json');
    let calls = 0;
    const fetchProfile: ProfileFetcher = async () => {
      calls++;
      return { finnhubIndustry: 'Technology' };
    };

    await runStockSectorLookup(fakeCtx(), { portfolioPath, outPath, apiKey: 'key', fetchProfile });
    assert.equal(calls, 1);

    // A new ticker appears alongside the already-resolved one.
    writeFileSync(
      portfolioPath,
      JSON.stringify([pos({ ticker: 'IDEMPOTENT1' }), pos({ ticker: 'IDEMPOTENT2' })]),
    );
    await runStockSectorLookup(fakeCtx(), { portfolioPath, outPath, apiKey: 'key', fetchProfile });

    assert.equal(calls, 2); // only IDEMPOTENT2 looked up the second run
    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.deepEqual(written, { IDEMPOTENT1: 'Technology', IDEMPOTENT2: 'Technology' });
  });

  it('records an unresolved lookup (no finnhubIndustry) as failed/retryable, not success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-sector-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(portfolioPath, JSON.stringify([pos({ ticker: 'UNRESOLVED1' })]));
    const outPath = join(dir, 'sectors.json');
    const fetchProfile: ProfileFetcher = async () => ({});

    await runStockSectorLookup(fakeCtx(), { portfolioPath, outPath, apiKey: 'key', fetchProfile });

    assert.equal(isWorkItemDone(JOB, 'UNRESOLVED1', 3), false);
    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.deepEqual(written, { UNRESOLVED1: null });
  });

  it('still records a resolved lookup as success (unchanged path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-sector-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(portfolioPath, JSON.stringify([pos({ ticker: 'RESOLVED1' })]));
    const outPath = join(dir, 'sectors.json');
    const fetchProfile: ProfileFetcher = async () => ({ finnhubIndustry: 'Technology' });

    await runStockSectorLookup(fakeCtx(), { portfolioPath, outPath, apiKey: 'key', fetchProfile });

    assert.equal(isWorkItemDone(JOB, 'RESOLVED1', 1), true);
  });

  it('records a failed lookup without crashing the run and leaves it retryable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-sector-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(portfolioPath, JSON.stringify([pos({ ticker: 'BADTICKER' })]));
    const outPath = join(dir, 'sectors.json');
    const fetchProfile: ProfileFetcher = async () => {
      throw new Error('HTTP 404');
    };

    await runStockSectorLookup(fakeCtx(), { portfolioPath, outPath, apiKey: 'key', fetchProfile });

    assert.equal(isWorkItemDone(JOB, 'BADTICKER', 3), false);
  });

  it('queries Finnhub with the OpenFIGI-resolved real-world ticker (T373), not the stale/raw Trading212 ticker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-sector-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(
      portfolioPath,
      JSON.stringify([pos({ ticker: 'YNDX_US_EQ', resolvedTicker: 'NBIS' })]),
    );
    const outPath = join(dir, 'sectors.json');
    const calls: string[] = [];
    const fetchProfile: ProfileFetcher = async (symbol) => {
      calls.push(symbol);
      return { finnhubIndustry: 'Technology' };
    };

    await runStockSectorLookup(fakeCtx(), { portfolioPath, outPath, apiKey: 'key', fetchProfile });

    assert.deepEqual(calls, ['NBIS']);
    // ledger stays keyed by the ORIGINAL Trading212 ticker, matching sectorBreakdown's lookup key
    assert.equal(isWorkItemDone(JOB, 'YNDX_US_EQ', 1), true);
    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.deepEqual(written, { YNDX_US_EQ: 'Technology' });
  });

  it('falls back to the raw Trading212 ticker when no resolvedTicker is present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-sector-'));
    const portfolioPath = join(dir, 'portfolio.json');
    writeFileSync(portfolioPath, JSON.stringify([pos({ ticker: 'NORESOLVE1' })]));
    const outPath = join(dir, 'sectors.json');
    const calls: string[] = [];
    const fetchProfile: ProfileFetcher = async (symbol) => {
      calls.push(symbol);
      return { finnhubIndustry: 'Technology' };
    };

    await runStockSectorLookup(fakeCtx(), { portfolioPath, outPath, apiKey: 'key', fetchProfile });

    assert.deepEqual(calls, ['NORESOLVE1']);
  });
});

describe('readPortfolio', () => {
  it('returns an empty array when the file does not exist', () => {
    assert.deepEqual(readPortfolio('/nonexistent/portfolio.json'), []);
  });
});
