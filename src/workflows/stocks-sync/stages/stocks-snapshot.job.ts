import type { JobDefinition } from '../../../core/types.js';
import { stocksNamedPositionsContract, stocksPortfolioContract } from '../contracts.js';
import { runStocksSnapshot } from './stocks-snapshot.js';

const job: JobDefinition = {
  name: 'stocks-snapshot',
  description:
    'Build the portfolio report from stocks-resolve-names\' named positions: write ' +
    'data/out/portfolio.json + data/out/portfolio.md (with a company-name column). Pure report ' +
    'builder — no resolution of its own. Idempotent per calendar day.',
  timeoutMs: 60_000,
  maxRetries: 3,
  consumes: [stocksNamedPositionsContract()],
  produces: [stocksPortfolioContract()],
  async run(ctx) {
    await runStocksSnapshot(ctx);
  },
};

export default job;
