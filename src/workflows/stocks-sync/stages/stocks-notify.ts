import { readFileSync } from 'fs';

import { push } from '../../../core/notifier.js';
import type { JobContext } from '../../../core/types.js';
import { markWorkItem } from '../../../db/store.js';
import { positionKey } from '../../../services/trading212.service.js';
import { stocksSyncConfig } from '../config.js';
import { WATCH_JOB, type BreachLine } from './stocks-watch.js';

export type PushFn = typeof push;

export function formatBreachLine(b: BreachLine): string {
  const sign = b.gain >= 0 ? '+' : '';
  const label = b.account === 'isa' ? `${b.ticker} (ISA)` : b.ticker;
  return `${label} ${sign}${b.gain.toFixed(0)}% since last buy ($${b.averageBuyPrice.toFixed(2)} → $${b.currentPrice.toFixed(2)})`;
}

export function buildDigest(breaches: BreachLine[]): { title: string; body: string } {
  const title = breaches.length === 1
    ? '📈 1 position up 30%+ since your buy price'
    : `📈 ${breaches.length} positions up 30%+ since your buy price`;
  const body = breaches.map(formatBreachLine).join('\n');
  return { title, body };
}

function readFreshBreaches(path: string): BreachLine[] {
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as BreachLine[];
  } catch {
    return [];
  }
}

/**
 * Notify stage (T300 — split from the combined check+notify stage). Reads
 * this run's fresh-breach list written by `stocks-watch` and, if non-empty,
 * sends exactly ONE push naming every fresh breach. If empty, this stage does
 * nothing — that's the CORRECT noop: the framework may legitimately show
 * `stocks-notify` as skipped, meaning "nothing to send this run." (It was
 * `stocks-watch`'s checking work being mislabeled skipped that was the bug —
 * see T300.)
 */
export async function runStocksNotify(
  ctx: JobContext,
  opts: {
    push?: PushFn;
    freshBreachesPath?: string;
  } = {},
): Promise<void> {
  const pushFn = opts.push ?? push;
  const freshBreachesPath = opts.freshBreachesPath ?? stocksSyncConfig.freshBreachesJsonPath;

  const freshBreaches = readFreshBreaches(freshBreachesPath);
  ctx.log(`stocks-notify starting — read ${freshBreaches.length} fresh breach(es) from ${freshBreachesPath}`);

  if (freshBreaches.length === 0) {
    ctx.log('stocks-notify complete — no fresh breaches, no notification sent');
    return;
  }

  const digest = buildDigest(freshBreaches);
  ctx.log(`sending ONE push for ${freshBreaches.length} fresh breach(es): ${digest.title}`);
  const res = await pushFn(digest.title, digest.body, { job: 'stocks-notify' });
  ctx.log(res.ok ? 'stocks-notify complete — notification sent' : `stocks-notify — push FAILED: ${res.error}`, res.ok ? 'info' : 'error');
  if (!res.ok) {
    throw new Error(`Breach push failed — ${res.error}`);
  }

  for (const b of freshBreaches) {
    const notifiedKey = `${positionKey(b.account, b.ticker)}::notified`;
    const label = b.account === 'isa' ? `${b.ticker} (ISA)` : b.ticker;
    markWorkItem(WATCH_JOB, notifiedKey, 'success', {
      detail: {
        name: `${label} — notified breach`,
        ticker: b.ticker,
        account: b.account,
        gainPct: b.gain,
        averageBuyPrice: b.averageBuyPrice,
        currentPrice: b.currentPrice,
      },
    });
  }
}
