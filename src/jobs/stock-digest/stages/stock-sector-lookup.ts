import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

import { callService } from '../../../core/services.js';
import type { JobContext } from '../../../core/types.js';
import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import { stocksSyncConfig } from '../../stocks-sync/config.js';
import type { NormalizedPosition } from '../../stocks-sync/stages/stocks-snapshot.js';
import { sectorsJsonPath, stockDigestConfig } from '../config.js';

const JOB_NAME = 'stock-sector-lookup';
const MAX_ATTEMPTS = 3;

/** ticker -> Finnhub `finnhubIndustry` (or null if the lookup couldn't resolve one). */
export type SectorMap = Record<string, string | null>;

// ---------------------------------------------------------------------------
// Portfolio read (mirrors stock-digest-build's readPortfolio — tolerant of missing/empty file)
// ---------------------------------------------------------------------------

export function readPortfolio(path: string): NormalizedPosition[] {
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as NormalizedPosition[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function readSectorMap(path: string): SectorMap {
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as SectorMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Finnhub company-profile fetch (injectable for tests)
// ---------------------------------------------------------------------------

export interface FinnhubProfile {
  finnhubIndustry?: string;
}

export type ProfileFetcher = (ticker: string, apiKey: string) => Promise<FinnhubProfile>;

/**
 * Translate a Trading212 ticker (e.g. `AMD_US_EQ`) to a Finnhub-compatible bare
 * symbol (`AMD`) — Finnhub doesn't recognize Trading212's `_EQ`/market-code suffix
 * and silently returns an empty profile instead of erroring. Strips a trailing
 * `_EQ` and, if what remains ends in a 2-letter uppercase market/country code,
 * strips that too. Deliberately NOT "everything from the first underscore" —
 * `BRK_B_US_EQ` (Berkshire class B) has an underscore that's part of the symbol
 * itself, not a market code.
 */
export function toFinnhubSymbol(t212Ticker: string): string {
  return t212Ticker.replace(/_EQ$/, '').replace(/_[A-Z]{2}$/, '');
}

export async function fetchFinnhubProfile(ticker: string, apiKey: string): Promise<FinnhubProfile> {
  const symbol = toFinnhubSymbol(ticker);
  const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`Finnhub profile2 request failed for ${ticker}: HTTP ${res.status}`);
  }
  return (await res.json()) as FinnhubProfile;
}

// ---------------------------------------------------------------------------
// Core stage logic
// ---------------------------------------------------------------------------

export async function runStockSectorLookup(
  ctx: JobContext,
  opts: {
    portfolioPath?: string;
    outPath?: string;
    apiKey?: string;
    fetchProfile?: ProfileFetcher;
  } = {},
): Promise<void> {
  const portfolioPath = opts.portfolioPath ?? stocksSyncConfig.portfolioJsonPath;
  const outPath = opts.outPath ?? sectorsJsonPath;
  const apiKey = opts.apiKey ?? process.env.FINNHUB_API_KEY ?? '';
  const fetchProfile = opts.fetchProfile ?? ((ticker, key) => callService('finnhub', () => fetchFinnhubProfile(ticker, key)));

  ctx.log(`info: stock-sector-lookup starting — reading portfolio from ${portfolioPath}`);

  const positions = readPortfolio(portfolioPath);
  if (positions.length === 0) {
    ctx.log(`warn: no positions found at ${portfolioPath} — stocks-sync may not have run yet; nothing to resolve`);
    ctx.progress(100, 'skipped — no portfolio data');
    return;
  }

  const tickers = [...new Set(positions.map((p) => p.ticker))].filter((t) => ctx.rootAllowed(t));
  ctx.log(`info: ${tickers.length} distinct ticker(s) currently held`);

  if (!apiKey) {
    ctx.log('warn: FINNHUB_API_KEY not set — skipping sector lookups; stock-digest will omit the diversification section');
    ctx.progress(100, 'skipped — no FINNHUB_API_KEY');
    return;
  }

  const sectors = existsSync(outPath) ? readSectorMap(outPath) : {};

  const todo = tickers.filter((t) => !isWorkItemDone(JOB_NAME, t, MAX_ATTEMPTS));
  ctx.log(`info: ${tickers.length - todo.length} ticker(s) already resolved (skipped) · ${todo.length} to look up this run`);

  let resolved = 0;
  let failed = 0;
  for (let i = 0; i < todo.length; i++) {
    const ticker = todo[i];
    try {
      const profile = await fetchProfile(ticker, apiKey);
      const industry = profile.finnhubIndustry ?? null;
      sectors[ticker] = industry;
      if (industry) {
        markWorkItem(JOB_NAME, ticker, 'success', { detail: { name: ticker, industry } });
        ctx.log(`info: [${i + 1}/${todo.length}] ${ticker} -> industry "${industry}"`);
        resolved++;
      } else {
        markWorkItem(JOB_NAME, ticker, 'failed', {
          detail: { name: ticker, error: 'Finnhub returned no finnhubIndustry field (symbol not recognized, or genuinely unclassified)' },
        });
        ctx.log(`warn: [${i + 1}/${todo.length}] ${ticker} -> Finnhub returned no finnhubIndustry field`);
        failed++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`warn: [${i + 1}/${todo.length}] ${ticker} lookup failed: ${message}`);
      markWorkItem(JOB_NAME, ticker, 'failed', { detail: { name: ticker, error: message } });
      failed++;
    }
    ctx.progress(((i + 1) / todo.length) * 100, `resolved ${i + 1}/${todo.length}`);
  }

  mkdirSync(stockDigestConfig.outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(sectors, null, 2), 'utf8');
  ctx.log(`info: wrote sector map (${Object.keys(sectors).length} ticker(s) total) to ${outPath}`);
  ctx.log(`info: stock-sector-lookup complete — ${resolved} resolved, ${failed} failed/unresolved this run`);
  ctx.progress(100, `${resolved} resolved, ${failed} failed/unresolved`);
}
