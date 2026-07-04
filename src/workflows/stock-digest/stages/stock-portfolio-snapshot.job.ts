import type { JobDefinition } from '../../../core/types.js';
import { stockDigestPortfolioContract } from '../contracts.js';
import { runStockPortfolioSnapshot } from './stock-portfolio-snapshot.js';

const job: JobDefinition = {
  name: 'stock-portfolio-snapshot',
  description:
    'Fetch stock-digest\'s OWN current open equity positions from Trading212 (read-only), ' +
    'independent of stocks-sync, resolving each position\'s ISIN + real-world ticker via ' +
    'OpenFIGI (T373), and write data/out/portfolio.json.',
  timeoutMs: 60_000,
  maxRetries: 3,
  produces: [stockDigestPortfolioContract()],
  async run(ctx) {
    await runStockPortfolioSnapshot(ctx);
  },
};

export default job;
