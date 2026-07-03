import { mkdirSync, writeFileSync } from 'fs';

import { callService } from '../../../core/services.js';
import { markWorkItem, workItemCounts } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { fetchOpenFigiTickers } from '../../../services/openfigi.service.js';
import { stocksSyncConfig } from '../config.js';

const JOB_NAME = 'stocks-snapshot';
const T212_LIVE_BASE = 'https://live.trading212.com/api/v0';

/** Job-count limit per OpenFIGI mapping request — 10 without an API key, 100 with one. */
const OPENFIGI_BATCH_SIZE_NO_KEY = 10;
const OPENFIGI_BATCH_SIZE_WITH_KEY = 100;

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

/** Which Trading212 account a position was fetched from. */
export type Trading212Account = 'invest' | 'isa';

/** The broker-agnostic, normalized shape written to data/out/portfolio.json. */
export interface NormalizedPosition {
  ticker: string;
  quantity: number;
  averageBuyPrice: number;
  currentPrice: number;
  currentValue: number;
  account: Trading212Account;
  /** ISIN resolved from Trading212's instruments-metadata endpoint (T373). Omitted on a miss. */
  isin?: string;
  /** Current, real-world ticker resolved via OpenFIGI from `isin` (T373). Omitted on a miss. */
  resolvedTicker?: string;
}

/** Composite ledger/lookup key — tickers can collide across accounts (T301). */
export function positionKey(account: Trading212Account, ticker: string): string {
  return `${account}:${ticker}`;
}

// ---------------------------------------------------------------------------
// Trading212 instruments-metadata (ticker -> ISIN lookup, T373)
// ---------------------------------------------------------------------------

export interface Trading212Instrument {
  ticker: string;
  name: string;
  isin: string;
  currencyCode: string;
  type: string;
  [key: string]: unknown;
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

export type InstrumentsMetadataFetcher = (apiKeyId: string, apiSecretKey: string) => Promise<Trading212Instrument[]>;

/**
 * GET-only, read-only call to Trading212's instruments-metadata endpoint. This is a
 * SEPARATE, more tightly rate-limited endpoint than the portfolio one (1 request per
 * 50 seconds per Trading212's OpenAPI spec) — callers must call this AT MOST ONCE per
 * stage run, never once per position.
 *
 * NEVER issue a POST/PUT/PATCH/DELETE here — see the root CLAUDE.md and
 * src/services/CLAUDE.md read-only rule.
 */
export async function fetchInstrumentsMetadata(
  apiKeyId: string,
  apiSecretKey: string,
): Promise<Trading212Instrument[]> {
  const basicAuth = Buffer.from(`${apiKeyId}:${apiSecretKey}`).toString('base64');
  const res = await fetch(`${T212_LIVE_BASE}/equity/metadata/instruments`, {
    method: 'GET',
    headers: { Authorization: `Basic ${basicAuth}` },
  });
  if (!res.ok) {
    throw new Error(`Trading212 API error ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as Trading212Instrument[];
}

// ---------------------------------------------------------------------------
// Normalize (broker-agnostic — no Trading212-specific field names)
// ---------------------------------------------------------------------------

export function normalizePosition(pos: Trading212Position, account: Trading212Account = 'invest'): NormalizedPosition {
  return {
    ticker: pos.ticker,
    quantity: pos.quantity,
    averageBuyPrice: pos.averagePrice,
    currentPrice: pos.currentPrice,
    currentValue: pos.quantity * pos.currentPrice,
    account,
  };
}

// ---------------------------------------------------------------------------
// ISIN + real-ticker resolution (T373): Trading212 ticker -> ISIN -> real ticker
// ---------------------------------------------------------------------------

export type OpenFigiTickerResolver = (isins: string[]) => Promise<(string | null)[]>;

/**
 * Resolves each position's Trading212 ticker to an ISIN (via the instruments-metadata
 * lookup map) and then to a current, real-world ticker (via OpenFIGI), mutating
 * nothing — returns a NEW array of positions with `isin`/`resolvedTicker` populated
 * where resolvable. A miss at either step is soft — the position is left without the
 * new fields and a warn is logged, never a throw.
 */
export async function resolveTickers(
  ctx: JobContext,
  positions: NormalizedPosition[],
  isinByTicker: Map<string, string>,
  resolveOpenFigiTickers: OpenFigiTickerResolver,
): Promise<NormalizedPosition[]> {
  const isins: string[] = [];
  for (const p of positions) {
    const isin = isinByTicker.get(p.ticker);
    if (!isin) {
      ctx.log(`warn: could not resolve ISIN for Trading212 ticker ${p.ticker} — skipping ticker resolution`);
      continue;
    }
    isins.push(isin);
  }

  const uniqueIsins = Array.from(new Set(isins));
  const tickerByIsin = new Map<string, string | null>();
  if (uniqueIsins.length > 0) {
    const resolved = await resolveOpenFigiTickers(uniqueIsins);
    uniqueIsins.forEach((isin, i) => tickerByIsin.set(isin, resolved[i] ?? null));
  }

  return positions.map((p) => {
    const isin = isinByTicker.get(p.ticker);
    if (!isin) return p;
    const resolvedTicker = tickerByIsin.get(isin) ?? null;
    if (!resolvedTicker) {
      ctx.log(`warn: OpenFIGI has no ticker mapping for ISIN ${isin} (Trading212 ticker ${p.ticker})`);
      return { ...p, isin };
    }
    return { ...p, isin, resolvedTicker };
  });
}

/** Batches ISINs into OpenFIGI mapping requests respecting its per-request job-count limit. */
export async function resolveOpenFigiTickersBatched(isins: string[], apiKey?: string): Promise<(string | null)[]> {
  const batchSize = apiKey ? OPENFIGI_BATCH_SIZE_WITH_KEY : OPENFIGI_BATCH_SIZE_NO_KEY;
  const results: (string | null)[] = [];
  for (let i = 0; i < isins.length; i += batchSize) {
    const batch = isins.slice(i, i + batchSize);
    const batchResult = await callService('openfigi', () => fetchOpenFigiTickers(batch, apiKey));
    results.push(...batchResult);
  }
  return results;
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
// Core sync logic (injectable dependencies for hermeticity in tests)
// ---------------------------------------------------------------------------

export async function runStocksSnapshot(
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

  ctx.log('info: stocks-sync starting — fetching open positions from Trading212 (read-only)');

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
    markWorkItem(JOB_NAME, positionKey(p.account, p.ticker), 'success', {
      detail: {
        name: `${p.ticker}${p.account === 'isa' ? ' (ISA)' : ''}`,
        currentPrice: p.currentPrice,
        averageBuyPrice: p.averageBuyPrice,
        markdown: stocksSyncConfig.portfolioMdPath,
      },
    });
    done++;
    ctx.log(
      `info: recorded ${done}/${positions.length} — [${p.account}] ${p.ticker}: qty ${p.quantity}, ` +
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
    return positions.map((p) => positionKey(p.account, p.ticker));
  } catch {
    return [];
  }
}
