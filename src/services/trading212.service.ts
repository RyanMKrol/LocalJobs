import type { JobContext, ServiceDefinition } from '../core/types.js';
import { callService } from '../core/services.js';
import { fetchOpenFigiTickers } from './openfigi.service.js';

/**
 * Trading212 Public API — https://docs.trading212.com/api
 *
 * READ-ONLY use only, always — see the root CLAUDE.md "Broker / trading APIs are
 * READ-ONLY, always" rule and src/services/CLAUDE.md. This service must NEVER issue
 * a mutating (POST/PUT/PATCH/DELETE) request to Trading212.
 *
 * Free API; Trading212 rate-limits per-endpoint (portfolio is roughly 1 req/sec on
 * their side). We poll infrequently (daily), so conservative limits are far below
 * any real ceiling.
 */
const service: ServiceDefinition = {
  name: 'trading212',
  category: 'api',
  description:
    'Trading212 Public API (https://docs.trading212.com/api) — READ-ONLY portfolio ' +
    'fetch only. No mutating requests are ever made.',
  ratePerMinute: Number(process.env.TRADING212_RATE_PER_MIN ?? 10),
  dailyCap: Number(process.env.TRADING212_DAILY_CAP ?? 100),
  monthlyCap: Number(process.env.TRADING212_MONTHLY_CAP ?? 1_000),
  paid: false,
};

export default service;

// ---------------------------------------------------------------------------
// Shared fetch/normalize/resolve helpers — used by any workflow that needs its
// own Trading212 portfolio snapshot (stocks-sync, stock-digest). Deliberately
// self-contained: no workflow-owned config is imported here, only core types
// + the sibling openfigi service. NEVER add a mutating (POST/PUT/PATCH/DELETE)
// call in this file — see the read-only rule above.
// ---------------------------------------------------------------------------

const T212_LIVE_BASE = 'https://live.trading212.com/api/v0';

/** Job-count limit per OpenFIGI mapping request — 10 without an API key, 100 with one. */
const OPENFIGI_BATCH_SIZE_NO_KEY = 10;
const OPENFIGI_BATCH_SIZE_WITH_KEY = 100;

// Types matching Trading212's GET /equity/portfolio response shape (confirmed
// live against the real account — see https://docs.trading212.com/api)

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

/** The broker-agnostic, normalized shape any consuming workflow writes to its own data/out. */
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
  /** Company name resolved from Trading212's instruments-metadata endpoint (T413). Omitted on a miss. */
  name?: string;
}

/** Composite ledger/lookup key — tickers can collide across accounts (T301). */
export function positionKey(account: Trading212Account, ticker: string): string {
  return `${account}:${ticker}`;
}

export interface Trading212Instrument {
  ticker: string;
  name: string;
  isin: string;
  currencyCode: string;
  type: string;
  [key: string]: unknown;
}

// Injectable fetch (real implementation calls the live Trading212 API; tests
// inject a stub — mirrors the ReposFetcher idiom in projects-sync/github-sync.ts)

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

// Normalize (broker-agnostic — no Trading212-specific field names)

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

// ISIN + real-ticker resolution (T373): Trading212 ticker -> ISIN -> real ticker

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

/**
 * Batches ISINs into OpenFIGI mapping requests respecting its per-request job-count
 * limit, routed through the shared `openfigi` service quota (`callService`) — the
 * same global rate/spend gating regardless of which workflow calls this.
 */
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
