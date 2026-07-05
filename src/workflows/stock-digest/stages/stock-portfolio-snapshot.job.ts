import type { JobDefinition } from '../../../core/types.js';
import { stockDigestPortfolioContract, stockRawPortfolioContract } from '../contracts.js';
import { runStockPortfolioSnapshot } from './stock-portfolio-snapshot.js';

const job: JobDefinition = {
  name: 'stock-portfolio-snapshot',
  description:
    'Resolve each of stock-digest\'s OWN Trading212 positions (from stock-portfolio-fetch\'s ' +
    'raw-portfolio.json) to its ISIN + real-world ticker via OpenFIGI (T373), and write ' +
    'data/out/portfolio.json.',
  timeoutMs: 60_000,
  maxRetries: 3,
  consumes: [stockRawPortfolioContract()],
  produces: [stockDigestPortfolioContract()],
  async run(ctx) {
    await runStockPortfolioSnapshot(ctx);
  },
};

export default job;
