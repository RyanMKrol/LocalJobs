import type { JobDefinition } from '../../../core/types.js';
import { stocksNamedPositionsContract, stocksPortfolioContract } from '../contracts.js';
import { runStocksSnapshot } from './stocks-snapshot.js';

const job: JobDefinition = {
  name: 'stocks-snapshot',
  description:
    'Resolve each fetched position\'s ISIN + real-world ticker (Trading212 instruments-metadata ' +
    '+ OpenFIGI), then write data/out/portfolio.json + data/out/portfolio.md. Idempotent per ' +
    'calendar day.',
  timeoutMs: 60_000,
  maxRetries: 3,
  consumes: [stocksNamedPositionsContract()],
  produces: [stocksPortfolioContract()],
  async run(ctx) {
    await runStocksSnapshot(ctx);
  },
};

export default job;
