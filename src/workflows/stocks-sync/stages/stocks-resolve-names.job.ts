import { defineStage } from '../../../engine/index.js';
import { stocksSyncConfig } from '../config.js';
import { namedPositions, rawPositions } from '../contracts.js';
import { runStocksResolveNames } from './stocks-resolve-names.js';

export default defineStage({
  name: 'stocks-resolve-names',
  description:
    'Fills in the company name of each position stocks-fetch wrote, using Trading212\'s own ' +
    'instruments-metadata endpoint. That endpoint is called at most once per run, never once per ' +
    'position, through the trading212-instruments service, which spaces requests 50 seconds apart ' +
    'because Trading212 documents the endpoint as one request per 50 seconds. No OpenFIGI lookup ' +
    'and no ISIN are involved. A ticker with no match is logged as a warning and its name is left ' +
    'unset, which never fails the stage. Like every broker call in this repo the request is ' +
    'strictly read-only (GET only) and never places, modifies or cancels anything. The result is ' +
    'written to data/out/named-positions.json for stocks-snapshot to read. When no positions are ' +
    'held it writes an empty list and makes no metadata call. The stage writes no work-item ' +
    'ledger rows: the named positions file is its declared output.',
  timeoutMs: 60_000,
  maxRetries: 3,
  inputs: { raw: { artifact: rawPositions } },
  outputs: { named: { artifact: namedPositions, location: () => stocksSyncConfig.namedPositionsJsonPath } },
  async run(ctx) {
    await runStocksResolveNames(ctx, { readRawPositions: () => ctx.input('raw').read() });
  },
});
