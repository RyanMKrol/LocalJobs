import type { JobDefinition } from '../../../core/types.js';
import { stockDigestPortfolioContract, stockRawPortfolioContract } from '../contracts.js';
import { runStockPortfolioSnapshot } from './stock-portfolio-snapshot.js';

const job: JobDefinition = {
  name: 'stock-portfolio-snapshot',
  description:
    'The second of stock-digest\'s two Trading212 stages, reading the raw combined Invest+ISA ' +
    'position list that stock-portfolio-fetch wrote to raw-portfolio.json and resolving each ' +
    'position\'s ISIN to a real-world ticker symbol via OpenFIGI (T373). The underlying instrument ' +
    'metadata lookup is routed through the dedicated trading212-instruments service, which enforces ' +
    'the endpoint\'s documented one-request-per-fifty-seconds pacing, so this stage can take a while ' +
    'on a portfolio with many distinct instruments. The resolved ticker matters downstream: ' +
    'stock-sector-lookup prefers it over the raw Trading212 ticker when querying Finnhub, since ' +
    'Trading212\'s own ticker format can go stale after a company rename. Writes the resolved ' +
    'snapshot to data/out/portfolio.json, and soft-skips with a clear warning (rather than failing) ' +
    'when the upstream fetch returned no positions or credentials are unset.',
  timeoutMs: 60_000,
  maxRetries: 3,
  consumes: [stockRawPortfolioContract()],
  produces: [stockDigestPortfolioContract()],
  async run(ctx) {
    await runStockPortfolioSnapshot(ctx);
  },
};

export default job;
