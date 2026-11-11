import { defineStage } from '../../../engine/index.js';
import { rawPortfolioJsonPath } from '../config.js';
import { rawPortfolio } from '../contracts.js';
import { runStockPortfolioFetch } from './stock-portfolio-fetch.js';

export default defineStage({
  name: 'stock-portfolio-fetch',
  description:
    'The first stage of the stock-digest workflow: fetches stock-digest\'s own copy of the ' +
    'current open equity positions from the Trading212 Invest account (and the Stocks & Shares ' +
    'ISA account too, when TRADING212_ISA_API_KEY_ID / _SECRET_KEY are configured), tags each ' +
    'position with its account and merges them into one list, then writes ' +
    'data/out/raw-portfolio.json for stock-portfolio-snapshot to resolve. It does not read ' +
    'anything stocks-sync wrote, and it does no ISIN or ticker resolution of its own. Like every ' +
    'job that talks to a broker in this repo, the Trading212 calls made here are strictly ' +
    'read-only (GET-only, HTTP Basic auth) and never place, modify, or cancel anything. The file ' +
    'is written on every run, even when zero positions are held. The stage writes no work-item ' +
    'ledger rows: the raw portfolio file is its declared output.',
  timeoutMs: 60_000,
  maxRetries: 3,
  // Fetched afresh from Trading212 (read-only) on every run.
  outputs: { raw: { artifact: rawPortfolio, location: () => rawPortfolioJsonPath } },
  async run(ctx) {
    await runStockPortfolioFetch(ctx);
  },
});
