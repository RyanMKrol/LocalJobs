import { defineStage } from '../../../engine/index.js';
import { stocksSyncConfig } from '../config.js';
import { rawPositions } from '../contracts.js';
import { runStocksFetch } from './stocks-fetch.js';

export default defineStage({
  name: 'stocks-fetch',
  description:
    'The first stage of the stocks-sync workflow: calls the Trading212 Invest portfolio ' +
    'endpoint (and the separate Stocks & Shares ISA account too, when TRADING212_ISA_API_KEY_ID ' +
    '/ _SECRET_KEY are configured) to fetch every currently-held open equity position, tags each ' +
    'one with its account (\'invest\' or \'isa\') and merges them into a single list, then writes ' +
    'the result to data/out/raw-positions.json for stocks-resolve-names to pick up. It does no ' +
    'ticker or company-name resolution of its own — that is deliberately left to the next stage. ' +
    'Like every job that talks to a broker in this repo, the Trading212 calls made here are ' +
    'strictly read-only (GET-only, HTTP Basic auth) and never place, modify, or cancel anything. ' +
    'The file is written on every run, even when zero positions are held. The stage writes no ' +
    'work-item ledger rows: the raw positions file is its declared output.',
  timeoutMs: 60_000,
  maxRetries: 3,
  // Fetched afresh from Trading212 (read-only) on every run.
  outputs: { raw: { artifact: rawPositions, location: () => stocksSyncConfig.rawPositionsJsonPath } },
  async run(ctx) {
    await runStocksFetch(ctx);
  },
});
