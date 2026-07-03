import type { JobDefinition } from '../../../core/types.js';
import { stocksPortfolioContract } from '../contracts.js';
import { runStocksSnapshot, stocksSnapshotInputKeys } from './stocks-snapshot.js';

const job: JobDefinition = {
  name: 'stocks-snapshot',
  description:
    'Fetch the owner\'s current open equity positions from Trading212 (read-only) and write ' +
    'data/out/portfolio.json + data/out/portfolio.md. Idempotent per ticker.',
  timeoutMs: 60_000,
  maxRetries: 3,
  inputKeys: stocksSnapshotInputKeys,
  produces: [stocksPortfolioContract()],
  async run(ctx) {
    await runStocksSnapshot(ctx);
  },
};

export default job;
