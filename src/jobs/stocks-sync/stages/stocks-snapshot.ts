import { mkdirSync, writeFileSync } from 'fs';

import { callService } from '../../../core/services.js';
import { markWorkItem, workItemCounts } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { stocksSyncConfig } from '../config.js';

const JOB_NAME = 'stocks-snapshot';
const T212_LIVE_BASE = 'https://live.trading212.com/api/v0';

// ---------------------------------------------------------------------------
// Types matching Trading212's GET /equity/portfolio response shape (confirmed
// live against the real account — see https://docs.trading212.com/api)
// ---------------------------------------------------------------------------

export interface Trading212Position {
  ticker: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  ppl: number;
  fxPpl: number | null;
  initialFillDate: string;
  frontend: string;
  maxBuy: number;
  maxSell: number | null;
  pieQuantity: number;
}

/** The broker-agnostic, normalized shape written to data/out/portfolio.json. */
export interface NormalizedPosition {
  ticker: string;
  quantity: number;
  averageBuyPrice: number;
  currentPrice: number;
  currentValue: number;
}

// ---------------------------------------------------------------------------
// Injectable fetch (real implementation calls the live Trading212 API; tests
// inject a stub — mirrors the ReposFetcher idiom in projects-sync/github-sync.ts)
// ---------------------------------------------------------------------------

export type PortfolioFetcher = (apiKeyId: string, apiSecretKey: string) => Promise<Trading212Position[]>;

/**
 * GET-only, read-only call to Trading212's Personal Portfolio endpoint. Auth is
 * HTTP Basic with the key id as username and the secret key as password (confirmed
 * live — the API rejects a bare Authorization: <keyId> header with 401).
 *
 * NEVER issue a POST/PUT/PATCH/DELETE here — see the root CLAUDE.md and
 * src/services/CLAUDE.md read-only rule.
 */
export async function fetchPortfolio(apiKeyId: string, apiSecretKey: string): Promise<Trading212Position[]> {
  const basicAuth = Buffer.from(`${apiKeyId}:${apiSecretKey}`).toString('base64');
  const res = await fetch(`${T212_LIVE_BASE}/equity/portfolio`, {
    method: 'GET',
    headers: { Authorization: `Basic ${basicAuth}` },
  });
  if (!res.ok) {
    throw new Error(`Trading212 API error ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as Trading212Position[];
}

// ---------------------------------------------------------------------------
// Normalize (broker-agnostic — no Trading212-specific field names)
// ---------------------------------------------------------------------------

export function normalizePosition(pos: Trading212Position): NormalizedPosition {
  return {
    ticker: pos.ticker,
    quantity: pos.quantity,
    averageBuyPrice: pos.averagePrice,
    currentPrice: pos.currentPrice,
    currentValue: pos.quantity * pos.currentPrice,
  };
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
  lines.push('| Ticker | Quantity | Avg buy price | Current price | Diff | Diff % |');
  lines.push('|---|---|---|---|---|---|');
  for (const p of positions) {
    const { absolute, percent } = priceDiff(p);
    const sign = absolute >= 0 ? '+' : '';
    lines.push(
      `| ${p.ticker} | ${fmt(p.quantity)} | ${fmt(p.averageBuyPrice)} | ${fmt(p.currentPrice)} | ` +
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
// Core sync logic (injectable dependencies for hermeticity in tests)
// ---------------------------------------------------------------------------

export async function runStocksSnapshot(
  ctx: JobContext,
  opts: {
    fetchPortfolio?: PortfolioFetcher;
    writePortfolio?: PortfolioWriter;
  } = {},
): Promise<void> {
  const apiKeyId = process.env.TRADING212_API_KEY_ID ?? '';
  const apiSecretKey = process.env.TRADING212_API_SECRET_KEY ?? '';
  if (!apiKeyId) throw new Error('TRADING212_API_KEY_ID is not set');
  if (!apiSecretKey) throw new Error('TRADING212_API_SECRET_KEY is not set');

  const fetchPortfolioFn =
    opts.fetchPortfolio ??
    ((keyId, secret) => callService('trading212', () => fetchPortfolio(keyId, secret)));
  const writePortfolioFn = opts.writePortfolio ?? writePortfolio;

  ctx.log('info: stocks-sync starting — fetching open positions from Trading212 (read-only)');

  const rawPositions = await fetchPortfolioFn(apiKeyId, apiSecretKey);
  ctx.log(`info: fetched ${rawPositions.length} open position(s) from Trading212`);

  const counts = workItemCounts(JOB_NAME);
  ctx.log(`info: ledger: ${counts['success'] ?? 0} previously recorded`);

  const positions = rawPositions.map(normalizePosition);
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
    markWorkItem(JOB_NAME, p.ticker, 'success');
    done++;
    ctx.log(
      `info: recorded ${done}/${positions.length} — ${p.ticker}: qty ${p.quantity}, ` +
        `avg ${p.averageBuyPrice}, current ${p.currentPrice}, diff ${absolute.toFixed(2)} (${percent.toFixed(2)}%)`,
    );
    ctx.progress((done / positions.length) * 100, `${done}/${positions.length} recorded`);
  }

  ctx.log(`info: stocks-sync complete — recorded ${done} out of ${positions.length} position(s)`);
}

/** Root stage inputKeys(): the current open-position tickers. */
export async function stocksSnapshotInputKeys(): Promise<string[]> {
  try {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(stocksSyncConfig.portfolioJsonPath, 'utf-8');
    const positions = JSON.parse(raw) as NormalizedPosition[];
    return positions.map((p) => p.ticker);
  } catch {
    return [];
  }
}
