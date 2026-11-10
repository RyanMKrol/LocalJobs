import { defineStage } from '../../../engine/index.js';
import { stocksSyncConfig } from '../config.js';
import { namedPositions, rawPositions } from '../contracts.js';
import { runStocksResolveNames } from './stocks-resolve-names.js';

export default defineStage({
  name: 'stocks-resolve-names',
  description:
    'Resolve each fetched position\'s company name from Trading212\'s own instruments-metadata ' +
    'endpoint (no OpenFIGI), then write data/out/named-positions.json for stocks-snapshot to read.',
  timeoutMs: 60_000,
  maxRetries: 3,
  inputs: { raw: { artifact: rawPositions } },
  outputs: { named: { artifact: namedPositions, location: () => stocksSyncConfig.namedPositionsJsonPath } },
  async run(ctx) {
    await runStocksResolveNames(ctx, { readRawPositions: () => ctx.input('raw').read() });
  },
});
