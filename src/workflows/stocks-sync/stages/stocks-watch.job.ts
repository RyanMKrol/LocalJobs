import { defineStage } from '../../../engine/index.js';
import { stocksSyncConfig } from '../config.js';
import { freshBreaches, portfolio } from '../contracts.js';
import { runStocksWatch } from './stocks-watch.js';

export default defineStage({
  name: 'stocks-watch',
  description:
    'Reads the portfolio.json snapshot written by stocks-snapshot and computes each held ' +
    'position\'s gain since its average buy price. A position counts as a fresh breach when its ' +
    'gain is at or above the threshold (STOCKS_WATCH_BREACH_PCT, default 30%) and it has not ' +
    'already been announced. "Already announced" is tracked in the work-item ledger on the key ' +
    '"<account>:<ticker>::notified": stocks-notify sets it once the push has gone out, it is left ' +
    'alone while the gain stays above the threshold, and this stage resets it when the gain drops ' +
    'back below, so a later re-crossing counts as fresh again. Every fresh breach found this run ' +
    'is written to data/out/fresh-breaches.json for stocks-notify to read and push. The file is ' +
    'written on every run and is an empty list on a normal day. The stage also re-records one ' +
    'ledger row per position, keyed "<account>:<ticker>", holding its latest gain.',
  timeoutMs: 60_000,
  maxRetries: 3,
  inputs: { portfolio: { artifact: portfolio } },
  // Written every run, and empty on a normal day.
  outputs: { breaches: { artifact: freshBreaches, location: () => stocksSyncConfig.freshBreachesJsonPath } },
  describeItem: (d) => ({
    title: String(d.name ?? ''),
    fields: [
      ...(typeof d.gainPct === 'number' ? [{ label: 'Gain', value: `${d.gainPct.toFixed(1)}%` }] : []),
      ...(d.breaching === true ? [{ label: 'Above threshold', value: 'yes' }] : []),
    ],
  }),
  async run(ctx) {
    await runStocksWatch(ctx, { portfolioPath: ctx.input('portfolio').path, freshBreachesPath: ctx.output('breaches').path });
  },
});
