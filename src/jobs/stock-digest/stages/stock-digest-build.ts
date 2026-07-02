import { mkdirSync, readFileSync, writeFileSync } from 'fs';

import { markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { runClaude } from '../../../services/claude.js';
import { stocksSyncConfig } from '../../stocks-sync/config.js';
import type { NormalizedPosition } from '../../stocks-sync/stages/stocks-snapshot.js';
import { stockDigestConfig, reportPathFor } from '../config.js';

const JOB_NAME = 'stock-digest-build';

export const claudeModel = process.env.STOCK_DIGEST_CLAUDE_MODEL ?? 'claude-sonnet-5';
export const claudeEffort = process.env.STOCK_DIGEST_CLAUDE_EFFORT ?? 'medium';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** "2026-W27" — the ISO-8601 week key, used as the ledger key + output filename suffix. */
export function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO week: Thursday of this week determines the week-numbering year.
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/** "Week 27, 2026" — human-readable heading, derived from the same ISO week key. */
export function weekLabel(date: Date): string {
  const key = weekKey(date);
  const [year, w] = key.split('-W');
  return `Week ${Number(w)}, ${year}`;
}

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

export interface StockDigestFacts {
  weekLabel: string;
  generatedAtIso: string;
  totalValue: number;
  holdings: HoldingSummary[];
  winners: Mover[];
  losers: Mover[];
}

export function buildFacts(positions: NormalizedPosition[], now: Date): StockDigestFacts {
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
  };
}

export function buildDigestPrompt(facts: StockDigestFacts): string {
  return [
    'You are writing a short weekly personal-finance markdown report narrating the structured facts below.',
    'Do NOT invent any numbers — use only the figures provided. Write clear, concise prose plus tables.',
    'Structure the report as:',
    `# Stock Digest — ${facts.weekLabel}`,
    '## Holdings — a plain read of current positions (ticker, quantity, current value, % of total portfolio value)',
    '## Performance — winners/losers since purchase, biggest % movers',
    '',
    'Structured facts (JSON):',
    JSON.stringify(facts, null, 2),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Portfolio read (mirrors stocks-watch's readPortfolio — tolerant of missing/empty file)
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

// ---------------------------------------------------------------------------
// Core stage logic
// ---------------------------------------------------------------------------

export type ClaudeRunner = (prompt: string, model: string, effort?: string) => ReturnType<typeof runClaude>;

export async function runStockDigestBuild(
  ctx: JobContext,
  opts: {
    portfolioPath?: string;
    outDir?: string;
    now?: Date;
    claudeRunner?: ClaudeRunner;
  } = {},
): Promise<void> {
  const portfolioPath = opts.portfolioPath ?? stocksSyncConfig.portfolioJsonPath;
  const outDir = opts.outDir ?? stockDigestConfig.outDir;
  const now = opts.now ?? new Date();
  const key = weekKey(now);
  const label = weekLabel(now);
  const claudeRunner = opts.claudeRunner ?? runClaude;

  ctx.log(`info: stock-digest-build starting — week: ${key}, reading portfolio from ${portfolioPath}`);

  const positions = readPortfolio(portfolioPath);
  if (positions.length === 0) {
    ctx.log(
      `warn: no positions found at ${portfolioPath} — stocks-sync may not have run yet, or has zero holdings; skipping this run's digest`,
    );
    ctx.progress(100, 'skipped — no portfolio data');
    return;
  }

  ctx.log(`info: read ${positions.length} position(s) from ${portfolioPath}`);

  const facts = buildFacts(positions, now);
  ctx.log(`info: total portfolio value: ${facts.totalValue.toFixed(2)}`);
  for (const h of facts.holdings) {
    ctx.log(
      `info: [${h.account}] ${h.ticker}: qty ${h.quantity}, value ${h.currentValue.toFixed(2)}, ` +
        `${h.portfolioSharePct.toFixed(1)}% of portfolio, gain ${h.gainPct.toFixed(1)}% since buy`,
    );
  }
  ctx.log(
    `info: top winners: ${facts.winners.map((m) => `${m.ticker} ${m.gainPct.toFixed(1)}%`).join(', ') || 'none'}`,
  );
  ctx.log(
    `info: top losers: ${facts.losers.map((m) => `${m.ticker} ${m.gainPct.toFixed(1)}%`).join(', ') || 'none'}`,
  );

  const prompt = buildDigestPrompt(facts);
  ctx.log(`info: calling Claude (${claudeModel}, effort ${claudeEffort}) to narrate the digest…`);
  const result = await claudeRunner(prompt, claudeModel, claudeEffort);
  if (!result.ok) {
    throw new Error(`Claude call failed: ${result.error ?? 'unknown error'}`);
  }
  ctx.log('info: Claude narration received');

  mkdirSync(outDir, { recursive: true });
  const mdPath = reportPathFor(key, outDir);
  writeFileSync(mdPath, result.text, 'utf8');
  ctx.log(`info: wrote digest markdown to ${mdPath}`);

  markWorkItem(JOB_NAME, key, 'success', {
    detail: { name: `Stock digest — ${label}`, markdown: mdPath },
  });

  ctx.progress(100, `digest for ${label} written`);
  ctx.log(`info: stock-digest-build complete — ${positions.length} position(s) narrated for ${label}`);
}
