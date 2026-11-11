import { defineStage } from '../../../engine/index.js';
import { breachDigest, freshBreaches } from '../contracts.js';
import { runStocksNotify } from './stocks-notify.js';

export default defineStage({
  name: 'stocks-notify',
  description:
    'The last stage of the stocks-sync workflow: reads the fresh breaches stocks-watch wrote to ' +
    'data/out/fresh-breaches.json and, if there are any, sends a single combined push ' +
    'notification naming every position that newly rose above the gain threshold this run ' +
    '(several breaches share one push, never one per position). Only after the push has gone out ' +
    'does it mark each position as announced, on the "<account>:<ticker>::notified" key of the ' +
    'stocks-watch ledger, so a failed push fails the run and the same breaches are found fresh ' +
    'again next time. When the list is empty it sends nothing, which is the normal outcome on ' +
    'most days. Either way it commits a small digest saying how many positions it announced and ' +
    'which. The dashboard\'s Output section shows the portfolio instead, because stocks-snapshot ' +
    'is the stage marked as the workflow\'s product.',
  timeoutMs: 60_000,
  maxRetries: 3,
  inputs: { breaches: { artifact: freshBreaches } },
  outputs: { digest: { artifact: breachDigest } },
  async run(ctx) {
    const breaches = ctx.input('breaches');
    await runStocksNotify(ctx, { freshBreachesPath: breaches.path });
    // Reaching here means the push (if there was anything to push) went out.
    const sent = breaches.read();
    ctx.output('digest').write({ notified: sent.length, tickers: sent.map((b) => (b.account === 'isa' ? `${b.ticker} (ISA)` : b.ticker)) });
  },
});
