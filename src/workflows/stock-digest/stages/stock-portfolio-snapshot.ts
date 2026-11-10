import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

import { callService } from '../../../core/services.js';
import type { JobContext } from '../../../core/types.js';
import {
  fetchInstrumentsMetadata,
  resolveOpenFigiTickersBatched,
  resolveTickers,
  type InstrumentsMetadataFetcher,
  type NormalizedPosition,
  type OpenFigiTickerResolver,
} from '../../../services/trading212.service.js';
import { portfolioJsonPath, rawPortfolioJsonPath, stockDigestConfig } from '../config.js';
import { weekKey, weekLabel } from '../lib.js';

/** What one run wrote. Returned so a caller (and the tests) can see the numbers. */
export interface StockPortfolioSnapshotSummary {
  positionCount: number;
  totalValue: number;
  resolvedCount: number;
}

// ---------------------------------------------------------------------------
// Raw-portfolio reader (the hand-off from stock-portfolio-fetch)
// ---------------------------------------------------------------------------

export type RawPortfolioReader = () => NormalizedPosition[];

export function readRawPortfolio(): NormalizedPosition[] {
  if (!existsSync(rawPortfolioJsonPath)) return [];
  return JSON.parse(readFileSync(rawPortfolioJsonPath, 'utf8')) as NormalizedPosition[];
}

// ---------------------------------------------------------------------------
// Output writer (injectable for testing — avoids touching the real data dir)
// ---------------------------------------------------------------------------

export type PortfolioWriter = (positions: NormalizedPosition[]) => void;

export function writePortfolio(positions: NormalizedPosition[]): void {
  mkdirSync(stockDigestConfig.outDir, { recursive: true });
  writeFileSync(portfolioJsonPath, JSON.stringify(positions, null, 2));
}

// ---------------------------------------------------------------------------
// Core stage logic — resolves each position's ISIN + real-world ticker via
// OpenFIGI (T373), reading its input from stock-portfolio-fetch's
// raw-portfolio.json rather than fetching Trading212 positions directly.
// Deliberately independent of stocks-sync (own credentials read, own ISIN/
// OpenFIGI real-ticker resolution) via the shared
// src/services/trading212.service.ts.
//
// This stage writes no ledger row: portfolio.json is its declared output, and
// the run page shows that. The ISO week key is still used here for the
// limited-run check and the log lines; stock-sector-lookup and
// stock-digest-build pass the same week key as an explicit `rootKey` on their
// own rows, which does not need a row from this stage to exist.
// ---------------------------------------------------------------------------

export async function runStockPortfolioSnapshot(
  ctx: JobContext,
  opts: {
    readRawPortfolio?: RawPortfolioReader;
    fetchInstrumentsMetadata?: InstrumentsMetadataFetcher;
    resolveOpenFigiTickers?: OpenFigiTickerResolver;
    writePortfolio?: PortfolioWriter;
    now?: Date;
  } = {},
): Promise<StockPortfolioSnapshotSummary> {
  const now = opts.now ?? new Date();
  const key = weekKey(now);
  const label = weekLabel(now);

  if (!ctx.rootAllowed(key)) {
    ctx.log(`root ${key} not in this limited run's selection — skipping`);
    ctx.progress(100, 'skipped — not selected');
    return { positionCount: 0, totalValue: 0, resolvedCount: 0 };
  }

  const apiKeyId = process.env.TRADING212_API_KEY_ID ?? '';
  const apiSecretKey = process.env.TRADING212_API_SECRET_KEY ?? '';
  if (!apiKeyId) throw new Error('TRADING212_API_KEY_ID is not set');
  if (!apiSecretKey) throw new Error('TRADING212_API_SECRET_KEY is not set');

  const readRawPortfolioFn = opts.readRawPortfolio ?? readRawPortfolio;
  const fetchInstrumentsMetadataFn =
    opts.fetchInstrumentsMetadata ??
    ((keyId, secret) => callService('trading212-instruments', () => fetchInstrumentsMetadata(keyId, secret), { cacheKey: 't212-instruments:all' }));
  const resolveOpenFigiTickersFn =
    opts.resolveOpenFigiTickers ??
    ((isins) => resolveOpenFigiTickersBatched(isins, process.env.OPENFIGI_API_KEY));
  const writePortfolioFn = opts.writePortfolio ?? writePortfolio;

  ctx.log('stock-portfolio-snapshot starting — resolving tickers from stock-portfolio-fetch\'s raw-portfolio.json');

  let positions = readRawPortfolioFn();
  ctx.log(`read ${positions.length} raw position(s) from stock-portfolio-fetch`);

  if (positions.length > 0) {
    ctx.log('resolving ISIN + real-world ticker for each position via Trading212 instruments-metadata + OpenFIGI');
    try {
      const instruments = await fetchInstrumentsMetadataFn(apiKeyId, apiSecretKey);
      ctx.log(`fetched ${instruments.length} instrument(s) from Trading212 instruments-metadata`);
      const isinByTicker = new Map(instruments.map((i) => [i.ticker, i.isin]));
      positions = await resolveTickers(ctx, positions, isinByTicker, resolveOpenFigiTickersFn);
      const resolvedCount = positions.filter((p) => p.resolvedTicker).length;
      ctx.log(`resolved a real-world ticker for ${resolvedCount}/${positions.length} position(s)`);
    } catch (err) {
      ctx.log(`ticker resolution failed — continuing without isin/resolvedTicker: ${(err as Error).message}`, 'warn');
    }
  }

  writePortfolioFn(positions);
  ctx.log(`wrote ${positions.length} position(s) to data/out/portfolio.json`);

  for (const p of positions) {
    ctx.log(
      `[${p.account}] ${p.ticker}` +
        `${p.resolvedTicker ? ` (resolved: ${p.resolvedTicker})` : ''}: qty ${p.quantity}, ` +
        `avg ${p.averageBuyPrice}, current ${p.currentPrice}`,
    );
  }

  if (positions.length === 0) {
    ctx.log('no open positions to record — done');
    ctx.progress(100, 'no positions to record');
    return { positionCount: 0, totalValue: 0, resolvedCount: 0 };
  }

  const totalValue = positions.reduce((sum, p) => sum + p.currentValue, 0);
  const resolvedCount = positions.filter((p) => p.resolvedTicker).length;

  ctx.progress(100, `${positions.length} position(s) written for ${label}`);
  ctx.log(
    `stock-portfolio-snapshot complete for ${key} — ${positions.length} position(s), ` +
      `total value ${totalValue.toFixed(2)}, ${resolvedCount} real-ticker resolved`,
  );
  return { positionCount: positions.length, totalValue, resolvedCount };
}
