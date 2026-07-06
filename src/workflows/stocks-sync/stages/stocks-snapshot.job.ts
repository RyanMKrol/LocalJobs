import type { JobDefinition } from '../../../core/types.js';
import { stocksNamedPositionsContract, stocksPortfolioContract } from '../contracts.js';
import { runStocksSnapshot } from './stocks-snapshot.js';

const job: JobDefinition = {
  name: 'stocks-snapshot',
  description:
    'Builds the human-readable portfolio snapshot from the named positions ' +
    'stocks-resolve-names wrote: reads data/out/named-positions.json and writes ' +
    'data/out/portfolio.json (a structured, broker-agnostic array of ticker/quantity/average buy ' +
    'price/current price/current value/account) plus data/out/portfolio.md, a markdown table with ' +
    'one row per position, an Account column, and the company name (falling back to an em-dash ' +
    'when a name could not be resolved). This stage is a pure report builder — it makes no ' +
    'Trading212 or OpenFIGI calls of its own; all resolution work happens upstream in ' +
    'stocks-resolve-names. It records one combined work-item ledger row per calendar day (skipped ' +
    'entirely when there is nothing to record), and declares no inputKeys(), so it is not ' +
    'limitable from the dashboard\'s run-limit box.',
  timeoutMs: 60_000,
  maxRetries: 3,
  consumes: [stocksNamedPositionsContract()],
  produces: [stocksPortfolioContract()],
  async run(ctx) {
    await runStocksSnapshot(ctx);
  },
};

export default job;
