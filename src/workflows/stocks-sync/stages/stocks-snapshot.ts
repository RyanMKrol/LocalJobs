import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

import { callService } from '../../../core/services.js';
import type { JobContext } from '../../../core/types.js';
import { markWorkItem, workItemCounts } from '../../../db/store.js';
import {
  fetchInstrumentsMetadata,
  resolveOpenFigiTickersBatched,
  resolveTickers,
  type InstrumentsMetadataFetcher,
  type NormalizedPosition,
  type OpenFigiTickerResolver,
} from '../../../services/trading212.service.js';
import { stocksSyncConfig } from '../config.js';

const JOB_NAME = 'stocks-snapshot';

/** "2026-07-04" — the UTC calendar-day key, used as the single collapsed ledger key. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Markdown report (with price-difference column: absolute + percentage)
// ---------------------------------------------------------------------------

export function priceDiff(position: NormalizedPosition): { absolute: number; percent: number } {
  const absolute = position.currentPrice - position.averageBuyPrice;
  const percent = position.averageBuyPrice === 0 ? 0 : (absolute / position.averageBuyPrice) * 100;
  return { absolute, percent };
}

function fmt(n: number): string {
  return n.toFixed(2);
}

export function buildPortfolioMarkdown(positions: NormalizedPosition[]): string {
  const lines: string[] = [];
  lines.push('# Portfolio snapshot');
  lines.push('');
  lines.push('| Account | Ticker | Real ticker | Quantity | Avg buy price | Current price | Diff | Diff % |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const p of positions) {
    const { absolute, percent } = priceDiff(p);
    const sign = absolute >= 0 ? '+' : '';
    lines.push(
      `| ${p.account === 'isa' ? 'ISA' : 'Invest'} | ${p.ticker} | ${p.resolvedTicker ?? '—'} | ${fmt(p.quantity)} | ${fmt(p.averageBuyPrice)} | ${fmt(p.currentPrice)} | ` +
        `${sign}${fmt(absolute)} | ${sign}${fmt(percent)}% |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Output writers (injectable for testing — avoids touching the real data dir)
// ---------------------------------------------------------------------------

export type PortfolioWriter = (positions: NormalizedPosition[]) => void;

export function writePortfolio(positions: NormalizedPosition[]): void {
  mkdirSync(stocksSyncConfig.outDir, { recursive: true });
  writeFileSync(stocksSyncConfig.portfolioJsonPath, JSON.stringify(positions, null, 2));
  writeFileSync(stocksSyncConfig.portfolioMdPath, buildPortfolioMarkdown(positions));
}

// ---------------------------------------------------------------------------
// Raw-positions reader (the hand-off from stocks-fetch)
// ---------------------------------------------------------------------------

export type RawPositionsReader = () => NormalizedPosition[];

export function readRawPositions(): NormalizedPosition[] {
  if (!existsSync(stocksSyncConfig.namedPositionsJsonPath)) return [];
  return JSON.parse(readFileSync(stocksSyncConfig.namedPositionsJsonPath, 'utf8')) as NormalizedPosition[];
}

// ---------------------------------------------------------------------------
// Core sync logic (injectable dependencies for hermeticity in tests)
// ---------------------------------------------------------------------------

export async function runStocksSnapshot(
  ctx: JobContext,
  opts: {
    readRawPositions?: RawPositionsReader;
    fetchInstrumentsMetadata?: InstrumentsMetadataFetcher;
    resolveOpenFigiTickers?: OpenFigiTickerResolver;
    writePortfolio?: PortfolioWriter;
    now?: Date;
  } = {},
): Promise<void> {
  const apiKeyId = process.env.TRADING212_API_KEY_ID ?? '';
  const apiSecretKey = process.env.TRADING212_API_SECRET_KEY ?? '';
  if (!apiKeyId) throw new Error('TRADING212_API_KEY_ID is not set');
  if (!apiSecretKey) throw new Error('TRADING212_API_SECRET_KEY is not set');

  const readRawPositionsFn = opts.readRawPositions ?? readRawPositions;
  const fetchInstrumentsMetadataFn =
    opts.fetchInstrumentsMetadata ??
    ((keyId, secret) => callService('trading212', () => fetchInstrumentsMetadata(keyId, secret)));
  const resolveOpenFigiTickersFn =
    opts.resolveOpenFigiTickers ??
    ((isins) => resolveOpenFigiTickersBatched(isins, process.env.OPENFIGI_API_KEY));
  const writePortfolioFn = opts.writePortfolio ?? writePortfolio;
  const now = opts.now ?? new Date();

  ctx.log('info: stocks-snapshot starting — resolving ISIN + real-world ticker for fetched positions');

  let positions = readRawPositionsFn();
  ctx.log(`info: read ${positions.length} named position(s) from stocks-resolve-names`);

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

  const counts = workItemCounts(JOB_NAME);
  ctx.log(`info: ledger: ${counts['success'] ?? 0} previously recorded`);

  writePortfolioFn(positions);
  ctx.log(
    `info: wrote ${positions.length} position(s) to data/out/portfolio.json and data/out/portfolio.md`,
  );

  if (positions.length === 0) {
    ctx.log('info: no open positions to record — done');
    ctx.progress(100, 'no positions to record');
    return;
  }

  let done = 0;
  for (const p of positions) {
    const { absolute, percent } = priceDiff(p);
    done++;
    ctx.log(
      `info: [${done}/${positions.length}] [${p.account}] ${p.ticker}: qty ${p.quantity}, ` +
        `avg ${p.averageBuyPrice}, current ${p.currentPrice}, diff ${absolute.toFixed(2)} (${percent.toFixed(2)}%)`,
    );
    ctx.progress((done / positions.length) * 100, `${done}/${positions.length} processed`);
  }

  const totalValue = positions.reduce((sum, p) => sum + p.currentValue, 0);
  const resolvedCount = positions.filter((p) => p.resolvedTicker).length;
  const key = dayKey(now);

  markWorkItem(JOB_NAME, key, 'success', {
    detail: {
      name: `Portfolio snapshot — ${key}`,
      positionCount: positions.length,
      totalValue,
      resolvedCount,
      markdown: stocksSyncConfig.portfolioMdPath,
    },
  });

  ctx.log(
    `info: stocks-snapshot complete — recorded 1 combined ledger row (${key}) for ${positions.length} ` +
      `position(s), total value ${totalValue.toFixed(2)}, ${resolvedCount} real-ticker resolved`,
  );
  ctx.progress(100, `${positions.length} position(s) recorded for ${key}`);
}
