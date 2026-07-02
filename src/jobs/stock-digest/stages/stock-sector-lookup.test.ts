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
import { runStockSectorLookup, readPortfolio, readSectorMap, type ProfileFetcher } from './stock-sector-lookup.js';
import type { NormalizedPosition } from '../../stocks-sync/stages/stocks-snapshot.js';

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
});

describe('readPortfolio', () => {
  it('returns an empty array when the file does not exist', () => {
    assert.deepEqual(readPortfolio('/nonexistent/portfolio.json'), []);
  });
});
