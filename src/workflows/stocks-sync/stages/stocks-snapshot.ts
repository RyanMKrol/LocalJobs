import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

import type { JobContext } from '../../../core/types.js';
import { dayKey } from '../../../core/dates.js';
import type { NormalizedPosition } from '../../../services/trading212.service.js';
import { stocksSyncConfig } from '../config.js';

export { dayKey };

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
  lines.push('| Account | Ticker | Company name | Quantity | Avg buy price | Current price | Diff | Diff % |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const p of positions) {
    const { absolute, percent } = priceDiff(p);
    const sign = absolute >= 0 ? '+' : '';
    lines.push(
      `| ${p.account === 'isa' ? 'ISA' : 'Invest'} | ${p.ticker} | ${p.name ?? '—'} | ${fmt(p.quantity)} | ${fmt(p.averageBuyPrice)} | ${fmt(p.currentPrice)} | ` +
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
// Named-positions reader (the hand-off from stocks-resolve-names)
// ---------------------------------------------------------------------------

export type NamedPositionsReader = () => NormalizedPosition[];

export function readNamedPositions(): NormalizedPosition[] {
  if (!existsSync(stocksSyncConfig.namedPositionsJsonPath)) return [];
  return JSON.parse(readFileSync(stocksSyncConfig.namedPositionsJsonPath, 'utf8')) as NormalizedPosition[];
}

// ---------------------------------------------------------------------------
// Core sync logic (injectable dependencies for hermeticity in tests).
// Writes no ledger row: portfolio.json and portfolio.md are this stage's
// declared outputs, and the run page shows those.
// ---------------------------------------------------------------------------

/** What one run wrote. Returned so a caller (and the tests) can see the numbers. */
export interface StocksSnapshotSummary {
  positionCount: number;
  totalValue: number;
}

export async function runStocksSnapshot(
  ctx: JobContext,
  opts: {
    readNamedPositions?: NamedPositionsReader;
    writePortfolio?: PortfolioWriter;
    now?: Date;
  } = {},
): Promise<StocksSnapshotSummary> {
  const readNamedPositionsFn = opts.readNamedPositions ?? readNamedPositions;
  const writePortfolioFn = opts.writePortfolio ?? writePortfolio;
  const now = opts.now ?? new Date();

  ctx.log('stocks-snapshot starting — building the portfolio report from stocks-resolve-names output');

  const positions = readNamedPositionsFn();
  ctx.log(`read ${positions.length} named position(s) from stocks-resolve-names`);

  writePortfolioFn(positions);
  ctx.log(
    `wrote ${positions.length} position(s) to data/out/portfolio.json and data/out/portfolio.md`,
  );

  if (positions.length === 0) {
    ctx.log('no open positions to record — done');
    ctx.progress(100, 'no positions to record');
    return { positionCount: 0, totalValue: 0 };
  }

  let done = 0;
  for (const p of positions) {
    const { absolute, percent } = priceDiff(p);
    done++;
    ctx.log(
      `[${done}/${positions.length}] [${p.account}] ${p.ticker}: qty ${p.quantity}, ` +
        `avg ${p.averageBuyPrice}, current ${p.currentPrice}, diff ${absolute.toFixed(2)} (${percent.toFixed(2)}%)`,
    );
    ctx.progress((done / positions.length) * 100, `${done}/${positions.length} processed`);
  }

  const totalValue = positions.reduce((sum, p) => sum + p.currentValue, 0);
  const key = dayKey(now);

  ctx.log(
    `stocks-snapshot complete for ${key} — ${positions.length} position(s), ` +
      `total value ${totalValue.toFixed(2)}`,
  );
  ctx.progress(100, `${positions.length} position(s) written for ${key}`);
  return { positionCount: positions.length, totalValue };
}
