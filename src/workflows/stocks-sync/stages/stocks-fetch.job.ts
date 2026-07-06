import type { JobDefinition } from '../../../core/types.js';
import { stocksRawPositionsContract } from '../contracts.js';
import { runStocksFetch } from './stocks-fetch.js';

const job: JobDefinition = {
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
    'It records one combined work-item ledger row per calendar day, written unconditionally even ' +
    'when zero positions are held, so the ledger always reflects real activity rather than a ' +
    'stale no-op.',
  timeoutMs: 60_000,
  maxRetries: 3,
  produces: [stocksRawPositionsContract()],
  async run(ctx) {
    await runStocksFetch(ctx);
  },
};

export default job;
