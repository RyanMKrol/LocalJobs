import { writeFileSync } from 'fs';

import { isWorkItemDone, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { positionKey, type NormalizedPosition, type Trading212Account } from '../../../services/trading212.service.js';
import { readPortfolio } from '../../stock-digest/lib.js';
import { stocksSyncConfig } from '../config.js';

/** The work_items key-space for the position-check + notified-episode ledgers. */
export const WATCH_JOB = 'stocks-watch';

/**
 * A position rises this % or more above its average buy price to count as a
 * breach. Env-overridable via `STOCKS_WATCH_BREACH_PCT` (default 30) — see
 * `stocksSyncConfig.breachThresholdPct`.
 */
export function BREACH_THRESHOLD_PCT(): number {
  return stocksSyncConfig.breachThresholdPct();
}

export function gainPct(position: NormalizedPosition): number {
  if (position.averageBuyPrice === 0) return 0;
  return ((position.currentPrice - position.averageBuyPrice) / position.averageBuyPrice) * 100;
}

export function isBreaching(position: NormalizedPosition): boolean {
  return gainPct(position) >= BREACH_THRESHOLD_PCT();
}

export interface BreachLine {
  ticker: string;
  account: Trading212Account;
  gain: number;
  averageBuyPrice: number;
  currentPrice: number;
}

/**
 * Check stage. Reads the portfolio snapshot and, for every position on every
 * run, computes gainPct and records it with a `markWorkItem(key, 'success')`
 * call, where key is `<account>:<ticker>`. That row was added so the stage
 * always showed ledger activity under the old no-op detection, which now
 * applies only to limitable workflows. Nothing reads the row back.
 *
 * "Already notified for the current breach" is tracked on a SEPARATE ledger
 * key (`<account>:<ticker>::notified`), so the per-run row above cannot erase
 * it. `stocks-notify` sets that row to `success` once its push has gone out. A
 * position still above the threshold that was already notified is left alone.
 * Dropping back below the threshold resets the row to `skipped` here
 * (isWorkItemDone treats that as NOT done), so a later re-crossing notifies
 * again.
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
  const breachThreshold = BREACH_THRESHOLD_PCT();

  ctx.log(`stocks-watch starting — checking positions for a ${breachThreshold}%+ gain since average buy price`);

  const positions = readPortfolio(portfolioPath);
  ctx.log(`read ${positions.length} position(s) from ${portfolioPath}`);

  const freshBreaches: BreachLine[] = [];

  let processed = 0;
  for (const position of positions) {
    processed++;
    const gain = gainPct(position);
    const key = positionKey(position.account, position.ticker);
    const label = `[${position.account}] ${position.ticker}`;
    const notifiedKey = `${key}::notified`;
    const alreadyNotified = isWorkItemDone(WATCH_JOB, notifiedKey, 1);

    if (gain >= breachThreshold) {
      if (alreadyNotified) {
        ctx.log(`${label}: gain ${gain.toFixed(1)}% — still above threshold, already notified, skipping`);
      } else {
        ctx.log(`${label}: gain ${gain.toFixed(1)}% — FRESH breach of ${breachThreshold}%`);
        freshBreaches.push({
          ticker: position.ticker,
          account: position.account,
          gain,
          averageBuyPrice: position.averageBuyPrice,
          currentPrice: position.currentPrice,
        });
      }
    } else if (alreadyNotified) {
      ctx.log(`${label}: gain ${gain.toFixed(1)}% — dropped back below threshold, resetting ledger`);
      markWorkItem(WATCH_JOB, notifiedKey, 'skipped', {
        detail: {
          name: `${label} — reset (dropped below threshold)`,
          ticker: position.ticker,
          account: position.account,
          gainPct: gain,
        },
      });
    } else {
      ctx.log(`${label}: gain ${gain.toFixed(1)}% — below threshold`);
    }

    markWorkItem(WATCH_JOB, key, 'success', {
      detail: {
        name: label,
        ticker: position.ticker,
        account: position.account,
        gainPct: gain,
        breaching: gain >= breachThreshold,
      },
    });

    ctx.progress((processed / Math.max(positions.length, 1)) * 100, `${processed}/${positions.length} checked`);
  }

  writeFileSync(freshBreachesPath, JSON.stringify(freshBreaches, null, 2));
  ctx.log(`stocks-watch complete — ${freshBreaches.length} fresh breach(es) written to ${freshBreachesPath}`);
}
