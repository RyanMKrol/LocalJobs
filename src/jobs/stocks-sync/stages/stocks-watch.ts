import { readFileSync } from 'fs';

import { push } from '../../../core/notifier.js';
import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { stocksSyncConfig } from '../config.js';
import type { NormalizedPosition } from './stocks-snapshot.js';

/** The work_items key-space for the "already-notified this breach episode" ledger. */
export const WATCH_JOB = 'stocks-watch';

/** A position rises 30% or more above its average buy price to count as a breach. */
export const BREACH_THRESHOLD_PCT = 30;

export type PushFn = typeof push;

export function gainPct(position: NormalizedPosition): number {
  if (position.averageBuyPrice === 0) return 0;
  return ((position.currentPrice - position.averageBuyPrice) / position.averageBuyPrice) * 100;
}

export function isBreaching(position: NormalizedPosition): boolean {
  return gainPct(position) >= BREACH_THRESHOLD_PCT;
}

export interface BreachLine {
  ticker: string;
  gain: number;
  averageBuyPrice: number;
  currentPrice: number;
}

export function formatBreachLine(b: BreachLine): string {
  const sign = b.gain >= 0 ? '+' : '';
  return `${b.ticker} ${sign}${b.gain.toFixed(0)}% since last buy ($${b.averageBuyPrice.toFixed(2)} → $${b.currentPrice.toFixed(2)})`;
}

export function buildDigest(breaches: BreachLine[]): { title: string; body: string } {
  const title = breaches.length === 1
    ? '📈 1 position up 30%+ since your buy price'
    : `📈 ${breaches.length} positions up 30%+ since your buy price`;
  const body = breaches.map(formatBreachLine).join('\n');
  return { title, body };
}

export function readPortfolio(path: string): NormalizedPosition[] {
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as NormalizedPosition[];
  } catch {
    return [];
  }
}

/**
 * "Re-scan + notification-log" idempotency (mirrors missing-tv-seasons' notify
 * stage, per root CLAUDE.md): a ledger row per ticker means "already notified
 * for the CURRENT breach episode". A position freshly crossing >=30% notifies
 * once; staying above 30% notifies nothing further; dropping back under 30%
 * clears the row (marked `skipped`, which isWorkItemDone treats as NOT done)
 * so a later re-crossing notifies again.
 */
export async function runStocksWatch(
  ctx: JobContext,
  opts: {
    push?: PushFn;
    portfolioPath?: string;
  } = {},
): Promise<void> {
  const pushFn = opts.push ?? push;
  const portfolioPath = opts.portfolioPath ?? stocksSyncConfig.portfolioJsonPath;

  ctx.log('info: stocks-watch starting — checking positions for a 30%+ gain since average buy price');

  const positions = readPortfolio(portfolioPath);
  ctx.log(`info: read ${positions.length} position(s) from ${portfolioPath}`);

  const freshBreaches: BreachLine[] = [];

  let processed = 0;
  for (const position of positions) {
    processed++;
    const gain = gainPct(position);
    const alreadyNotified = isWorkItemDone(WATCH_JOB, position.ticker, 1);

    if (gain >= BREACH_THRESHOLD_PCT) {
      if (alreadyNotified) {
        ctx.log(`info: ${position.ticker}: gain ${gain.toFixed(1)}% — still above threshold, already notified, skipping`);
      } else {
        ctx.log(`info: ${position.ticker}: gain ${gain.toFixed(1)}% — FRESH breach of ${BREACH_THRESHOLD_PCT}%`);
        freshBreaches.push({
          ticker: position.ticker,
          gain,
          averageBuyPrice: position.averageBuyPrice,
          currentPrice: position.currentPrice,
        });
        markWorkItem(WATCH_JOB, position.ticker, 'success');
      }
    } else if (alreadyNotified) {
      ctx.log(`info: ${position.ticker}: gain ${gain.toFixed(1)}% — dropped back below threshold, resetting ledger`);
      markWorkItem(WATCH_JOB, position.ticker, 'skipped');
    } else {
      ctx.log(`info: ${position.ticker}: gain ${gain.toFixed(1)}% — below threshold`);
    }
    ctx.progress((processed / Math.max(positions.length, 1)) * 100, `${processed}/${positions.length} checked`);
  }

  if (freshBreaches.length === 0) {
    ctx.log('info: stocks-watch complete — no fresh breaches, no notification sent');
    return;
  }

  const digest = buildDigest(freshBreaches);
  ctx.log(`info: sending ONE push for ${freshBreaches.length} fresh breach(es): ${digest.title}`);
  await pushFn(digest.title, digest.body, { job: 'stocks-watch' });
  ctx.log('info: stocks-watch complete — notification sent');
}
