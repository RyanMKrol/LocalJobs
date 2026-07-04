import type { JobDefinition } from '../../../core/types.js';
import { stocksPortfolioContract } from '../contracts.js';
import { runStocksSnapshot } from './stocks-snapshot.js';

const job: JobDefinition = {
  name: 'stocks-snapshot',
  description:
    'Fetch the owner\'s current open equity positions from Trading212 (read-only) and write ' +
    'data/out/portfolio.json + data/out/portfolio.md. Idempotent per calendar day.',
  timeoutMs: 60_000,
  maxRetries: 3,
  produces: [stocksPortfolioContract()],
  async run(ctx) {
    await runStocksSnapshot(ctx);
  },
};

export default job;
