import { mkdirSync, writeFileSync } from 'fs';

import { callService } from '../../../core/services.js';
import type { JobContext } from '../../../core/types.js';
import { markWorkItem } from '../../../db/store.js';
import {
  fetchInstrumentsMetadata,
  fetchPortfolio,
  normalizePosition,
  positionKey,
  resolveOpenFigiTickersBatched,
  resolveTickers,
  type InstrumentsMetadataFetcher,
  type NormalizedPosition,
  type OpenFigiTickerResolver,
  type PortfolioFetcher,
} from '../../../services/trading212.service.js';
import { portfolioJsonPath, stockDigestConfig } from '../config.js';

const JOB_NAME = 'stock-portfolio-snapshot';

// ---------------------------------------------------------------------------
// Output writer (injectable for testing — avoids touching the real data dir)
// ---------------------------------------------------------------------------

export type PortfolioWriter = (positions: NormalizedPosition[]) => void;

export function writePortfolio(positions: NormalizedPosition[]): void {
  mkdirSync(stockDigestConfig.outDir, { recursive: true });
  writeFileSync(portfolioJsonPath, JSON.stringify(positions, null, 2));
}

// ---------------------------------------------------------------------------
// Core stage logic — deliberately independent of stocks-sync: fetches its OWN
// Trading212 snapshot rather than reading stocks-sync's data/out/portfolio.json,
// so stock-digest has no inter-workflow dependency. Mirrors stocks-sync's
// stocks-snapshot stage (same credentials, same ISIN/OpenFIGI real-ticker
// resolution, T373) via the shared src/services/trading212.service.ts.
// ---------------------------------------------------------------------------

export async function runStockPortfolioSnapshot(
  ctx: JobContext,
  opts: {
    fetchPortfolio?: PortfolioFetcher;
    fetchInstrumentsMetadata?: InstrumentsMetadataFetcher;
    resolveOpenFigiTickers?: OpenFigiTickerResolver;
    writePortfolio?: PortfolioWriter;
  } = {},
): Promise<void> {
  const apiKeyId = process.env.TRADING212_API_KEY_ID ?? '';
  const apiSecretKey = process.env.TRADING212_API_SECRET_KEY ?? '';
  if (!apiKeyId) throw new Error('TRADING212_API_KEY_ID is not set');
  if (!apiSecretKey) throw new Error('TRADING212_API_SECRET_KEY is not set');

  const isaApiKeyId = process.env.TRADING212_ISA_API_KEY_ID ?? '';
  const isaApiSecretKey = process.env.TRADING212_ISA_API_SECRET_KEY ?? '';
  const hasIsaCreds = Boolean(isaApiKeyId && isaApiSecretKey);

  const fetchPortfolioFn =
    opts.fetchPortfolio ??
    ((keyId, secret) => callService('trading212', () => fetchPortfolio(keyId, secret)));
  const fetchInstrumentsMetadataFn =
    opts.fetchInstrumentsMetadata ??
    ((keyId, secret) => callService('trading212', () => fetchInstrumentsMetadata(keyId, secret)));
  const resolveOpenFigiTickersFn =
    opts.resolveOpenFigiTickers ??
    ((isins) => resolveOpenFigiTickersBatched(isins, process.env.OPENFIGI_API_KEY));
  const writePortfolioFn = opts.writePortfolio ?? writePortfolio;

  ctx.log('info: stock-portfolio-snapshot starting — fetching stock-digest\'s own snapshot from Trading212 (read-only)');

  const rawInvestPositions = await fetchPortfolioFn(apiKeyId, apiSecretKey);
  ctx.log(`info: fetched ${rawInvestPositions.length} open position(s) from Trading212 Invest account`);

  let positions = rawInvestPositions.map((p) => normalizePosition(p, 'invest'));

  if (hasIsaCreds) {
    const rawIsaPositions = await fetchPortfolioFn(isaApiKeyId, isaApiSecretKey);
    ctx.log(`info: fetched ${rawIsaPositions.length} open position(s) from Trading212 ISA account`);
    positions = positions.concat(rawIsaPositions.map((p) => normalizePosition(p, 'isa')));
  } else {
    ctx.log('info: no ISA credentials configured (TRADING212_ISA_API_KEY_ID / _SECRET_KEY) — Invest account only');
  }

  if (positions.length > 0) {
    ctx.log('info: resolving ISIN + real-world ticker for each position via Trading212 instruments-metadata + OpenFIGI');
    try {
      const instruments = await fetchInstrumentsMetadataFn(apiKeyId, apiSecretKey);
      ctx.log(`info: fetched ${instruments.length} instrument(s) from Trading212 instruments-metadata`);
      const isinByTicker = new Map(instruments.map((i) => [i.ticker, i.isin]));
      positions = await resolveTickers(ctx, positions, isinByTicker, resolveOpenFigiTickersFn);
      const resolvedCount = positions.filter((p) => p.resolvedTicker).length;
      ctx.log(`info: resolved a real-world ticker for ${resolvedCount}/${positions.length} position(s)`);
    } catch (err) {
      ctx.log(`warn: ticker resolution failed — continuing without isin/resolvedTicker: ${(err as Error).message}`);
    }
  }

  const allowedPositions = positions.filter((p) => ctx.rootAllowed(positionKey(p.account, p.ticker)));

  writePortfolioFn(allowedPositions);
  ctx.log(`info: wrote ${allowedPositions.length} position(s) to data/out/portfolio.json`);

  if (allowedPositions.length === 0) {
    ctx.log('info: no open positions to record — done');
    ctx.progress(100, 'no positions to record');
    return;
  }

  let done = 0;
  for (const p of allowedPositions) {
    markWorkItem(JOB_NAME, positionKey(p.account, p.ticker), 'success', {
      detail: {
        name: `${p.ticker}${p.account === 'isa' ? ' (ISA)' : ''}`,
        currentPrice: p.currentPrice,
        averageBuyPrice: p.averageBuyPrice,
        resolvedTicker: p.resolvedTicker ?? null,
      },
    });
    done++;
    ctx.log(
      `info: recorded ${done}/${allowedPositions.length} — [${p.account}] ${p.ticker}` +
        `${p.resolvedTicker ? ` (resolved: ${p.resolvedTicker})` : ''}: qty ${p.quantity}, ` +
        `avg ${p.averageBuyPrice}, current ${p.currentPrice}`,
    );
    ctx.progress((done / allowedPositions.length) * 100, `${done}/${allowedPositions.length} recorded`);
  }

  ctx.log(`info: stock-portfolio-snapshot complete — recorded ${done} out of ${allowedPositions.length} position(s)`);
}
