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
import { stocksSyncConfig } from '../config.js';
import { dayKey } from './stocks-snapshot.js';

const JOB_NAME = 'stocks-fetch';

export type RawPositionsWriter = (positions: NormalizedPosition[]) => void;

export function writeRawPositions(positions: NormalizedPosition[]): void {
  mkdirSync(stocksSyncConfig.outDir, { recursive: true });
  writeFileSync(stocksSyncConfig.rawPositionsJsonPath, JSON.stringify(positions, null, 2));
}

/**
 * Stage 1: fetch open positions from Trading212 (Invest, and ISA if
 * configured), normalize + tag each by account, and write
 * data/out/raw-positions.json for `stocks-snapshot` to resolve real-world
 * tickers for. No ticker resolution happens here — that's the next stage.
 */
export async function runStocksFetch(
  ctx: JobContext,
  opts: {
    fetchPortfolio?: PortfolioFetcher;
    writeRawPositions?: RawPositionsWriter;
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
  const writeRawPositionsFn = opts.writeRawPositions ?? writeRawPositions;
  const now = opts.now ?? new Date();

  ctx.log('info: stocks-fetch starting — fetching open positions from Trading212 (read-only)');

  const rawInvestPositions = await callService('trading212', () => baseFetchFn(apiKeyId, apiSecretKey), {
    cacheKey: useCache ? 't212:portfolio:invest' : undefined,
  });
  ctx.log(`info: fetched ${rawInvestPositions.length} open position(s) from Trading212 Invest account`);
  let positions = rawInvestPositions.map((p) => normalizePosition(p, 'invest'));

  let isaCount = 0;
  if (hasIsaCreds) {
    const rawIsaPositions = await callService('trading212', () => baseFetchFn(isaApiKeyId, isaApiSecretKey), {
      cacheKey: useCache ? 't212:portfolio:isa' : undefined,
    });
    isaCount = rawIsaPositions.length;
    ctx.log(`info: fetched ${isaCount} open position(s) from Trading212 ISA account`);
    positions = positions.concat(rawIsaPositions.map((p) => normalizePosition(p, 'isa')));
  } else {
    ctx.log('info: no ISA credentials configured (TRADING212_ISA_API_KEY_ID / _SECRET_KEY) — Invest account only');
  }

  writeRawPositionsFn(positions);
  ctx.log(`info: wrote ${positions.length} raw position(s) to data/out/raw-positions.json`);

  const key = dayKey(now);
  const investCount = rawInvestPositions.length;

  markWorkItem(JOB_NAME, key, 'success', {
    detail: {
      name: `Positions fetched — ${key}`,
      investCount,
      isaCount,
      totalFetched: positions.length,
      path: stocksSyncConfig.rawPositionsJsonPath,
      format: 'json',
    },
  });

  ctx.log(
    `info: stocks-fetch complete — recorded 1 ledger row (${key}) for ${positions.length} ` +
      `fetched position(s) (${investCount} Invest, ${isaCount} ISA)`,
  );
  ctx.progress(100, `${positions.length} position(s) fetched for ${key}`);
}
