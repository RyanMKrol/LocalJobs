import { readFileSync, writeFileSync } from 'fs';

import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { positionKey, type NormalizedPosition, type Trading212Account } from '../../../services/trading212.service.js';
import { stocksSyncConfig } from '../config.js';

/** The work_items key-space for the position-check + notified-episode ledgers. */
export const WATCH_JOB = 'stocks-watch';

/** A position rises 30% or more above its average buy price to count as a breach. */
export const BREACH_THRESHOLD_PCT = 30;

export function gainPct(position: NormalizedPosition): number {
  if (position.averageBuyPrice === 0) return 0;
  return ((position.currentPrice - position.averageBuyPrice) / position.averageBuyPrice) * 100;
}

export function isBreaching(position: NormalizedPosition): boolean {
  return gainPct(position) >= BREACH_THRESHOLD_PCT;
}

export interface BreachLine {
  ticker: string;
  account: Trading212Account;
  gain: number;
  averageBuyPrice: number;
  currentPrice: number;
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
 * Check stage (T300 — split from the combined check+notify stage). Reads the
 * portfolio snapshot and, for EVERY position on EVERY run, computes gainPct
 * and records it via an UNCONDITIONAL `markWorkItem(ticker, 'success')` call —
 * so this stage always has ledger activity and can never be misclassified as
 * noop by the framework's `hasJobAdvancedAnyItem` heuristic, even when nothing
 * breaches.
 *
 * "Already notified for the current breach episode" is tracked on a SEPARATE
 * ledger key (`${ticker}::notified`) from the per-run check row (`ticker`)
 * above, so the unconditional per-run success marker doesn't erase the
 * notify-once-per-episode state: a position still above 30% that was already
 * notified stays untouched on its notified row; dropping back below 30%
 * resets that row to `skipped` (isWorkItemDone treats that as NOT done) so a
 * later re-crossing notifies again.
 *
 * This run's fresh-breach tickers are written to data/out/fresh-breaches.json
 * (empty array if none) for the downstream `stocks-notify` stage to send.
 */
export async function runStocksWatch(
  ctx: JobContext,
  opts: {
    portfolioPath?: string;
    freshBreachesPath?: string;
  } = {},
): Promise<void> {
  const portfolioPath = opts.portfolioPath ?? stocksSyncConfig.portfolioJsonPath;
  const freshBreachesPath = opts.freshBreachesPath ?? stocksSyncConfig.freshBreachesJsonPath;

  ctx.log('info: stocks-watch starting — checking positions for a 30%+ gain since average buy price');

  const positions = readPortfolio(portfolioPath);
  ctx.log(`info: read ${positions.length} position(s) from ${portfolioPath}`);

  const freshBreaches: BreachLine[] = [];

  let processed = 0;
  for (const position of positions) {
    processed++;
    const gain = gainPct(position);
    const key = positionKey(position.account, position.ticker);
    const label = `[${position.account}] ${position.ticker}`;
    const notifiedKey = `${key}::notified`;
    const alreadyNotified = isWorkItemDone(WATCH_JOB, notifiedKey, 1);

    if (gain >= BREACH_THRESHOLD_PCT) {
      if (alreadyNotified) {
        ctx.log(`info: ${label}: gain ${gain.toFixed(1)}% — still above threshold, already notified, skipping`);
      } else {
        ctx.log(`info: ${label}: gain ${gain.toFixed(1)}% — FRESH breach of ${BREACH_THRESHOLD_PCT}%`);
        freshBreaches.push({
          ticker: position.ticker,
          account: position.account,
          gain,
          averageBuyPrice: position.averageBuyPrice,
          currentPrice: position.currentPrice,
        });
      }
    } else if (alreadyNotified) {
      ctx.log(`info: ${label}: gain ${gain.toFixed(1)}% — dropped back below threshold, resetting ledger`);
      markWorkItem(WATCH_JOB, notifiedKey, 'skipped', {
        detail: {
          name: `${label} — reset (dropped below threshold)`,
          ticker: position.ticker,
          account: position.account,
          gainPct: gain,
        },
      });
    } else {
      ctx.log(`info: ${label}: gain ${gain.toFixed(1)}% — below threshold`);
    }

    markWorkItem(WATCH_JOB, key, 'success', {
      detail: { gainPct: gain, breaching: gain >= BREACH_THRESHOLD_PCT },
    });

    ctx.progress((processed / Math.max(positions.length, 1)) * 100, `${processed}/${positions.length} checked`);
  }

  writeFileSync(freshBreachesPath, JSON.stringify(freshBreaches, null, 2));
  ctx.log(`info: stocks-watch complete — ${freshBreaches.length} fresh breach(es) written to ${freshBreachesPath}`);
}
