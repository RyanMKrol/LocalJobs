import { defineStage } from '../../../engine/index.js';
import { portfolioJsonPath } from '../config.js';
import { digestPortfolio, rawPortfolio } from '../contracts.js';
import { runStockPortfolioSnapshot } from './stock-portfolio-snapshot.js';

export default defineStage({
  name: 'stock-portfolio-snapshot',
  description:
    'The second of stock-digest\'s two Trading212 stages, reading the raw combined Invest+ISA ' +
    'position list that stock-portfolio-fetch wrote to raw-portfolio.json and adding, where it ' +
    'can, each position\'s ISIN and a current real-world ticker symbol. The ISIN comes from one ' +
    'call per run to Trading212\'s instruments-metadata endpoint (a read-only GET, like every ' +
    'broker call in this repo), routed through the dedicated trading212-instruments service, ' +
    'which enforces the endpoint\'s documented one-request-per-fifty-seconds pacing, so the stage ' +
    'may wait for that gap before it starts. Each distinct ISIN is then looked up through the ' +
    'openfigi service to get the ticker. The resolved ticker matters downstream: ' +
    'stock-sector-lookup prefers it over the raw Trading212 ticker when querying Finnhub, since ' +
    'Trading212\'s own ticker format can go stale after a company rename. Resolution is best ' +
    'effort: a miss, or a failure of the whole lookup, is logged as a warning and the positions ' +
    'are written without those fields. Writes the snapshot to data/out/portfolio.json on every ' +
    'run, an empty list when nothing is held, and fails if the Trading212 credentials are not ' +
    'set. The stage writes no work-item ledger rows: the portfolio file is its declared output.',
  timeoutMs: 60_000,
  maxRetries: 3,
  inputs: { raw: { artifact: rawPortfolio } },
  outputs: { portfolio: { artifact: digestPortfolio, location: () => portfolioJsonPath } },
  async run(ctx) {
    await runStockPortfolioSnapshot(ctx, { readRawPortfolio: () => ctx.input('raw').read() });
  },
});
