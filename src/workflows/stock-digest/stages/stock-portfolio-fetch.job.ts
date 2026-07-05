import type { JobDefinition } from '../../../core/types.js';
import { stockRawPortfolioContract } from '../contracts.js';
import { runStockPortfolioFetch } from './stock-portfolio-fetch.js';

const job: JobDefinition = {
  name: 'stock-portfolio-fetch',
  description:
    'Fetch stock-digest\'s OWN current open equity positions from Trading212 Invest (and ISA, ' +
    'if configured), normalize + tag each by account, and write data/out/raw-portfolio.json for ' +
    'stock-portfolio-snapshot to resolve. No ISIN/OpenFIGI resolution here.',
  timeoutMs: 60_000,
  maxRetries: 3,
  produces: [stockRawPortfolioContract()],
  async run(ctx) {
    await runStockPortfolioFetch(ctx);
  },
};

export default job;
