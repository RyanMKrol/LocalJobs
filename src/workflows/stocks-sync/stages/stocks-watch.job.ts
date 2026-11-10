import { defineStage } from '../../../engine/index.js';
import { stocksSyncConfig } from '../config.js';
import { freshBreaches, portfolio } from '../contracts.js';
import { runStocksWatch } from './stocks-watch.js';

export default defineStage({
  name: 'stocks-watch',
  description:
    'Reads the portfolio.json snapshot written by stocks-snapshot and, every run, computes each ' +
    'held position\'s gain since its average buy price, writing to the work-item ledger ' +
    'unconditionally so a quiet run with nothing breaching still shows real ledger activity ' +
    'rather than a stale no-op. A position counts as a fresh breach once its gain reaches 30% or ' +
    'more AND it has not already been notified — tracked on a separate ' +
    '"<account>:<ticker>::notified" ledger key distinct from the per-run check key, set when the ' +
    'breach first occurs, left untouched while the gain stays above 30%, and reset once it drops ' +
    'back below so a later re-crossing of the threshold is treated as fresh again. Every fresh ' +
    'breach found this run is written to data/out/fresh-breaches.json for stocks-notify to read ' +
    'and push.',
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
