import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

import { callService } from '../../../core/services.js';
import type { JobContext } from '../../../core/types.js';
import { markWorkItem } from '../../../db/store.js';
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

const JOB_NAME = 'stock-portfolio-snapshot';

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
// Unlike stocks-sync's per-position ledger, this stage records ONE combined
// work_items row per run, keyed by the SAME ISO week key stock-digest-build
// uses — the whole workflow only ever runs its stages together, and the
// final report is bucketed weekly, so one shared week-keyed root gives every
// downstream stage (stock-sector-lookup's per-ticker rows, stock-digest-build's
// own row) something clean to point their `rootKey` at, instead of disjoint
// key spaces that don't join in the Input → Output panel.
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
): Promise<void> {
  const now = opts.now ?? new Date();
  const key = weekKey(now);
  const label = weekLabel(now);

  if (!ctx.rootAllowed(key)) {
    ctx.log(`root ${key} not in this limited run's selection — skipping`);
    ctx.progress(100, 'skipped — not selected');
    return;
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
    return;
  }

  const totalValue = positions.reduce((sum, p) => sum + p.currentValue, 0);
  const resolvedCount = positions.filter((p) => p.resolvedTicker).length;

  markWorkItem(JOB_NAME, key, 'success', {
    rootKey: key,
    detail: {
      name: `Portfolio snapshot — ${label}`,
      positionCount: positions.length,
      totalValue,
      resolvedCount,
    },
  });

  ctx.progress(100, `${positions.length} position(s) recorded for ${label}`);
  ctx.log(
    `stock-portfolio-snapshot complete — recorded 1 combined ledger row (${key}) for ` +
      `${positions.length} position(s), total value ${totalValue.toFixed(2)}, ${resolvedCount} real-ticker resolved`,
  );
}
