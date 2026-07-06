import type { JobDefinition } from '../../../core/types.js';
import { stockDigestPortfolioContract, stockSectorsContract } from '../contracts.js';
import { runStockDigestBuild } from './stock-digest-build.js';

const job: JobDefinition = {
  name: 'stock-digest-build',
  description:
    'Builds the weekly Claude-narrated markdown digest that is stock-digest\'s final output, fanning ' +
    'in both the portfolio snapshot from stock-portfolio-snapshot and (when available) the sector map ' +
    'from stock-sector-lookup. All numeric analysis is computed in code rather than left to the model: ' +
    'each position\'s gain since average buy price and share of total portfolio value, a ranked list ' +
    'of top winners and losers, and a grouping of portfolio value by resolved Finnhub industry for a ' +
    'sector-diversification section (omitted entirely if sectors.json is missing or empty, and noted ' +
    'in the digest as Finnhub\'s own classification rather than formal GICS). The computed facts are ' +
    'persisted to data/out/stock-digest-facts-<weekKey>.json before the Claude call so they survive on ' +
    'disk even if narration fails. After the model responds, a soft ticker-hallucination cross-check ' +
    'scans the generated markdown for ticker-shaped tokens that don\'t appear in the source holdings ' +
    'and aren\'t a known non-ticker acronym, logging a warning for any found without failing the run. ' +
    'Writes data/out/stock-digest-<weekKey>.md and is idempotent per ISO week via the work_items ' +
    'ledger, reading stock-digest\'s own portfolio snapshot independent of stocks-sync.',
  timeoutMs: 300_000,
  maxRetries: 3,
  consumes: [stockDigestPortfolioContract(), stockSectorsContract()],
  async run(ctx) {
    await runStockDigestBuild(ctx);
  },
};

export default job;
