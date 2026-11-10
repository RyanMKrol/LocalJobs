import { defineStage } from '../../../engine/index.js';
import { rawPortfolioJsonPath } from '../config.js';
import { rawPortfolio } from '../contracts.js';
import { runStockPortfolioFetch } from './stock-portfolio-fetch.js';

export default defineStage({
  name: 'stock-portfolio-fetch',
  description:
    'Fetch stock-digest\'s OWN current open equity positions from Trading212 Invest (and ISA, ' +
    'if configured), normalize + tag each by account, and write data/out/raw-portfolio.json for ' +
    'stock-portfolio-snapshot to resolve. No ISIN/OpenFIGI resolution here.',
  timeoutMs: 60_000,
  maxRetries: 3,
  // Fetched afresh from Trading212 (read-only) on every run.
  outputs: { raw: { artifact: rawPortfolio, location: () => rawPortfolioJsonPath } },
  async run(ctx) {
    await runStockPortfolioFetch(ctx);
  },
});
