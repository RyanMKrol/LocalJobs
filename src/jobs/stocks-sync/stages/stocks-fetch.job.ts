import type { JobDefinition } from '../../../core/types.js';
import { stocksRawPositionsContract } from '../contracts.js';
import { runStocksFetch } from './stocks-fetch.js';

const job: JobDefinition = {
  name: 'stocks-fetch',
  description:
    'Fetch the owner\'s current open equity positions from Trading212 Invest (and ISA, if ' +
    'configured), normalize + tag each by account, and write data/out/raw-positions.json for ' +
    'stocks-snapshot to resolve. No ticker resolution here.',
  timeoutMs: 60_000,
  maxRetries: 3,
  produces: [stocksRawPositionsContract()],
  async run(ctx) {
    await runStocksFetch(ctx);
  },
};

export default job;
