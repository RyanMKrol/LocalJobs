import type { JobDefinition } from '../../../core/types.js';
import { stocksNamedPositionsContract, stocksRawPositionsContract } from '../contracts.js';
import { runStocksResolveNames } from './stocks-resolve-names.js';

const job: JobDefinition = {
  name: 'stocks-resolve-names',
  description:
    'Resolve each fetched position\'s company name from Trading212\'s own instruments-metadata ' +
    'endpoint (no OpenFIGI), then write data/out/named-positions.json for stocks-snapshot to read.',
  timeoutMs: 60_000,
  maxRetries: 3,
  consumes: [stocksRawPositionsContract()],
  produces: [stocksNamedPositionsContract()],
  async run(ctx) {
    await runStocksResolveNames(ctx);
  },
};

export default job;
