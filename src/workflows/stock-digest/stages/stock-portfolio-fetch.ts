import { mkdirSync, writeFileSync } from 'fs';

import { callService } from '../../../core/services.js';
import type { JobContext } from '../../../core/types.js';
import { markWorkItem } from '../../../db/store.js';
import {
  fetchPortfolio,
  normalizePosition,
  type NormalizedPosition,
  type PortfolioFetcher,
} from '../../../services/trading212.service.js';
import { rawPortfolioJsonPath, stockDigestConfig } from '../config.js';
import { weekKey, weekLabel } from '../lib.js';

const JOB_NAME = 'stock-portfolio-fetch';

export type RawPortfolioWriter = (positions: NormalizedPosition[]) => void;

export function writeRawPortfolio(positions: NormalizedPosition[]): void {
  mkdirSync(stockDigestConfig.outDir, { recursive: true });
  writeFileSync(rawPortfolioJsonPath, JSON.stringify(positions, null, 2));
}

/**
 * Stage 1: fetch stock-digest's OWN open positions from Trading212 (Invest,
 * and ISA if configured), normalize + tag each by account, and write
 * data/out/raw-portfolio.json for `stock-portfolio-snapshot` to resolve
 * real-world tickers for. No ISIN/OpenFIGI resolution happens here — that's
 * the next stage. Mirrors stocks-sync's stocks-fetch stage.
 */
export async function runStockPortfolioFetch(
  ctx: JobContext,
  opts: {
    fetchPortfolio?: PortfolioFetcher;
    writeRawPortfolio?: RawPortfolioWriter;
    now?: Date;
  } = {},
): Promise<void> {
  const apiKeyId = process.env.TRADING212_API_KEY_ID ?? '';
  const apiSecretKey = process.env.TRADING212_API_SECRET_KEY ?? '';
  if (!apiKeyId) throw new Error('TRADING212_API_KEY_ID is not set');
  if (!apiSecretKey) throw new Error('TRADING212_API_SECRET_KEY is not set');

  const isaApiKeyId = process.env.TRADING212_ISA_API_KEY_ID ?? '';
  const isaApiSecretKey = process.env.TRADING212_ISA_API_SECRET_KEY ?? '';
  const hasIsaCreds = Boolean(isaApiKeyId && isaApiSecretKey);

  const baseFetchFn = opts.fetchPortfolio ?? fetchPortfolio;
  const useCache = !opts.fetchPortfolio;
  const writeRawPortfolioFn = opts.writeRawPortfolio ?? writeRawPortfolio;
  const now = opts.now ?? new Date();
  const key = weekKey(now);
  const label = weekLabel(now);

  ctx.log('stock-portfolio-fetch starting — fetching stock-digest\'s own snapshot from Trading212 (read-only)');

  const rawInvestPositions = await callService('trading212', () => baseFetchFn(apiKeyId, apiSecretKey), {
    cacheKey: useCache ? 't212:portfolio:invest' : undefined,
  });
  ctx.log(`fetched ${rawInvestPositions.length} open position(s) from Trading212 Invest account`);
  let positions = rawInvestPositions.map((p) => normalizePosition(p, 'invest'));

  let isaCount = 0;
  if (hasIsaCreds) {
    const rawIsaPositions = await callService('trading212', () => baseFetchFn(isaApiKeyId, isaApiSecretKey), {
      cacheKey: useCache ? 't212:portfolio:isa' : undefined,
    });
    isaCount = rawIsaPositions.length;
    ctx.log(`fetched ${isaCount} open position(s) from Trading212 ISA account`);
    positions = positions.concat(rawIsaPositions.map((p) => normalizePosition(p, 'isa')));
  } else {
    ctx.log('no ISA credentials configured (TRADING212_ISA_API_KEY_ID / _SECRET_KEY) — Invest account only');
  }

  writeRawPortfolioFn(positions);
  ctx.log(`wrote ${positions.length} raw position(s) to data/out/raw-portfolio.json`);

  const investCount = rawInvestPositions.length;

  markWorkItem(JOB_NAME, key, 'success', {
    detail: {
      name: `Positions fetched — ${label}`,
      investCount,
      isaCount,
      totalFetched: positions.length,
      path: rawPortfolioJsonPath,
      format: 'json',
    },
  });

  ctx.log(
    `stock-portfolio-fetch complete — recorded 1 ledger row (${key}) for ${positions.length} ` +
      `fetched position(s) (${investCount} Invest, ${isaCount} ISA)`,
  );
  ctx.progress(100, `${positions.length} position(s) fetched for ${label}`);
}
