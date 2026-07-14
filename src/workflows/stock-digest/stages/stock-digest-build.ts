import { mkdirSync, writeFileSync } from 'fs';

import { markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { runClaude } from '../../../services/claude.js';
import type { NormalizedPosition } from '../../../services/trading212.service.js';
import { stockDigestConfig, reportPathFor, factsPathFor, sectorsJsonPath, portfolioJsonPath } from '../config.js';
import { weekKey, weekLabel, readPortfolio } from '../lib.js';
import { readSectorMap, type SectorMap } from './stock-sector-lookup.js';

const JOB_NAME = 'stock-digest-build';

export const claudeModel = process.env.STOCK_DIGEST_CLAUDE_MODEL ?? 'claude-sonnet-5';
export const claudeEffort = process.env.STOCK_DIGEST_CLAUDE_EFFORT ?? 'medium';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Gain since average buy price, as a percentage. Mirrors stocks-watch's gainPct. */
export function gainPct(position: NormalizedPosition): number {
  if (position.averageBuyPrice === 0) return 0;
  return ((position.currentPrice - position.averageBuyPrice) / position.averageBuyPrice) * 100;
}

/** Share of total current portfolio value this position represents, as a percentage. */
export function portfolioSharePct(position: NormalizedPosition, totalValue: number): number {
  if (totalValue === 0) return 0;
  return (position.currentValue / totalValue) * 100;
}

export interface Mover {
  ticker: string;
  account: NormalizedPosition['account'];
  gainPct: number;
}

/** Top N winners and top N losers by gain %, sorted descending/ascending respectively. */
export function pickMovers(
  positions: NormalizedPosition[],
  count: number,
): { winners: Mover[]; losers: Mover[] } {
  const withGain: Mover[] = positions.map((p) => ({
    ticker: p.ticker,
    account: p.account,
    gainPct: gainPct(p),
  }));
  const sortedDesc = [...withGain].sort((a, b) => b.gainPct - a.gainPct);
  const winners = sortedDesc.slice(0, count);
  const losers = [...sortedDesc].reverse().slice(0, count);
  return { winners, losers };
}

export interface HoldingSummary {
  ticker: string;
  account: NormalizedPosition['account'];
  quantity: number;
  currentValue: number;
  gainPct: number;
  portfolioSharePct: number;
}

export interface SectorShare {
  industry: string;
  valuePct: number;
}

/**
 * % of total portfolio VALUE held per Finnhub industry classification.
 * Tickers with no resolved sector (missing from the map, or a null/unknown
 * lookup) are excluded from the breakdown entirely — a degraded/partial
 * sector map still produces a (partial) breakdown rather than failing.
 */
export function sectorBreakdown(positions: NormalizedPosition[], sectors: SectorMap): SectorShare[] {
  const totalValue = positions.reduce((sum, p) => sum + p.currentValue, 0);
  if (totalValue === 0) return [];

  const byIndustry = new Map<string, number>();
  for (const p of positions) {
    const industry = sectors[p.ticker];
    if (!industry) continue;
    byIndustry.set(industry, (byIndustry.get(industry) ?? 0) + p.currentValue);
  }

  return [...byIndustry.entries()]
    .map(([industry, value]) => ({ industry, valuePct: (value / totalValue) * 100 }))
    .sort((a, b) => b.valuePct - a.valuePct);
}

export interface StockDigestFacts {
  weekLabel: string;
  generatedAtIso: string;
  totalValue: number;
  holdings: HoldingSummary[];
  winners: Mover[];
  losers: Mover[];
  sectorBreakdown: SectorShare[];
}

export function buildFacts(
  positions: NormalizedPosition[],
  now: Date,
  sectors: SectorMap = {},
): StockDigestFacts {
  const totalValue = positions.reduce((sum, p) => sum + p.currentValue, 0);
  const holdings: HoldingSummary[] = positions
    .map((p) => ({
      ticker: p.ticker,
      account: p.account,
      quantity: p.quantity,
      currentValue: p.currentValue,
      gainPct: gainPct(p),
      portfolioSharePct: portfolioSharePct(p, totalValue),
    }))
    .sort((a, b) => b.currentValue - a.currentValue);
  const { winners, losers } = pickMovers(positions, stockDigestConfig.moversCount);

  return {
    weekLabel: weekLabel(now),
    generatedAtIso: now.toISOString(),
    totalValue,
    holdings,
    winners,
    losers,
    sectorBreakdown: sectorBreakdown(positions, sectors),
  };
}

export function buildDigestPrompt(facts: StockDigestFacts): string {
  const sections = [
    `# Stock Digest — ${facts.weekLabel}`,
    '## Holdings — a plain read of current positions (ticker, quantity, current value, % of total portfolio value)',
    '## Performance — winners/losers since purchase, biggest % movers',
  ];
  if (facts.sectorBreakdown.length > 0) {
    sections.push(
      '## Diversification — % of total portfolio value grouped by industry (`sectorBreakdown`). ' +
        'Note plainly that this is Finnhub\'s own industry classification, not a formal GICS sector, ' +
        'and that any ticker with no resolved industry is excluded from this breakdown.',
    );
  }
  return [
    'You are writing a short weekly personal-finance markdown report narrating the structured facts below.',
    'Do NOT invent any numbers — use only the figures provided. Write clear, concise prose plus tables.',
    'Structure the report as:',
    ...sections,
    '',
    'Structured facts (JSON):',
    JSON.stringify(facts, null, 2),
  ].join('\n');
}

/**
 * Common uppercase acronyms that legitimately appear in narrated prose but
 * aren't tickers. A living, adjustable heuristic — add to it as new
 * false-positives turn up in manual sample runs, not an exhaustive list.
 */
export const KNOWN_NON_TICKER_TOKENS = new Set([
  'ISA',
  'USD',
  'GBP',
  'EUR',
  'ETF',
  'N/A',
  'ID',
  'URL',
  'API',
]);

/** Scans narrated markdown text for ticker-shaped tokens (e.g. YNDX_US_EQ, AAPL). Deduped. */
export function extractCandidateTickers(text: string): string[] {
  const matches = text.match(/\b[A-Z][A-Z0-9]{1,9}(?:_[A-Z0-9]{1,9}){0,3}\b/g) ?? [];
  return [...new Set(matches)];
}

/** Candidate tokens that are neither a known holding ticker nor a stoplisted acronym. */
export function findUnknownTickers(candidates: string[], facts: StockDigestFacts): string[] {
  const knownTickers = new Set(facts.holdings.map((h) => h.ticker));
  return candidates.filter((c) => !knownTickers.has(c) && !KNOWN_NON_TICKER_TOKENS.has(c));
}

// ---------------------------------------------------------------------------
// Core stage logic
// ---------------------------------------------------------------------------

export type ClaudeRunner = (prompt: string, model: string, effort?: string) => ReturnType<typeof runClaude>;

export async function runStockDigestBuild(
  ctx: JobContext,
  opts: {
    portfolioPath?: string;
    sectorsPath?: string;
    outDir?: string;
    now?: Date;
    claudeRunner?: ClaudeRunner;
  } = {},
): Promise<void> {
  const portfolioPath = opts.portfolioPath ?? portfolioJsonPath;
  const sectorsPath = opts.sectorsPath ?? sectorsJsonPath;
  const outDir = opts.outDir ?? stockDigestConfig.outDir;
  const now = opts.now ?? new Date();
  const key = weekKey(now);
  const label = weekLabel(now);
  const claudeRunner = opts.claudeRunner ?? runClaude;

  ctx.log(`stock-digest-build starting — week: ${key}, reading portfolio from ${portfolioPath}`);

  const positions = readPortfolio(portfolioPath);
  if (positions.length === 0) {
    ctx.log(
      `no positions found at ${portfolioPath} — stock-portfolio-snapshot may not have run yet, or has zero holdings; skipping this run's digest`,
      'warn',
    );
    ctx.progress(100, 'skipped — no portfolio data');
    return;
  }

  ctx.log(`read ${positions.length} position(s) from ${portfolioPath}`);

  const sectors = readSectorMap(sectorsPath);
  const sectorCount = Object.values(sectors).filter(Boolean).length;
  if (sectorCount === 0) {
    ctx.log(`no resolved sectors found at ${sectorsPath} — digest will omit the diversification section`, 'warn');
  } else {
    ctx.log(`read ${sectorCount} resolved sector(s) from ${sectorsPath}`);
  }

  const facts = buildFacts(positions, now, sectors);
  ctx.log(`total portfolio value: ${facts.totalValue.toFixed(2)}`);
  for (const h of facts.holdings) {
    ctx.log(
      `[${h.account}] ${h.ticker}: qty ${h.quantity}, value ${h.currentValue.toFixed(2)}, ` +
        `${h.portfolioSharePct.toFixed(1)}% of portfolio, gain ${h.gainPct.toFixed(1)}% since buy`,
    );
  }
  ctx.log(
    `top winners: ${facts.winners.map((m) => `${m.ticker} ${m.gainPct.toFixed(1)}%`).join(', ') || 'none'}`,
  );
  ctx.log(
    `top losers: ${facts.losers.map((m) => `${m.ticker} ${m.gainPct.toFixed(1)}%`).join(', ') || 'none'}`,
  );
  if (facts.sectorBreakdown.length > 0) {
    for (const s of facts.sectorBreakdown) {
      ctx.log(`sector "${s.industry}": ${s.valuePct.toFixed(1)}% of portfolio`);
    }
  } else {
    ctx.log('sector breakdown empty — no tickers had a resolved industry; section omitted from digest');
  }

  mkdirSync(outDir, { recursive: true });
  const factsPath = factsPathFor(key, outDir);
  writeFileSync(factsPath, JSON.stringify(facts, null, 2), 'utf8');
  ctx.log(`wrote raw facts JSON to ${factsPath}`);

  const prompt = buildDigestPrompt(facts);
  ctx.log(`calling Claude (${claudeModel}, effort ${claudeEffort}) to narrate the digest…`);
  const result = await claudeRunner(prompt, claudeModel, claudeEffort);
  if (result.rateLimited) {
    ctx.log('Claude rate/usage limit hit — pausing this stage, will retry next run', 'warn');
    return;
  }
  if (!result.ok) {
    throw new Error(`Claude call failed: ${result.error ?? 'unknown error'}`);
  }
  ctx.log('Claude narration received');

  const unknownTickers = findUnknownTickers(extractCandidateTickers(result.text), facts);
  if (unknownTickers.length > 0) {
    ctx.log(
      `narrated digest mentions ticker-like token(s) not found in facts.holdings: ${unknownTickers.join(', ')} — possible narration drift, verify manually`,
      'warn',
    );
  }

  const mdPath = reportPathFor(key, outDir);
  writeFileSync(mdPath, result.text, 'utf8');
  ctx.log(`wrote digest markdown to ${mdPath}`);

  markWorkItem(JOB_NAME, key, 'success', {
    // Explicit rootKey (== this stage's own item_key here) so the Input → Output
    // panel's lineage is stated, not just relying on the item_key === root_key
    // default — matches the same shared week-key root stock-portfolio-snapshot
    // and stock-sector-lookup root themselves to.
    rootKey: key,
    detail: { name: `Stock digest — ${label}`, markdown: mdPath },
  });

  ctx.progress(100, `digest for ${label} written`);
  ctx.log(`stock-digest-build complete — ${positions.length} position(s) narrated for ${label}`);
}
