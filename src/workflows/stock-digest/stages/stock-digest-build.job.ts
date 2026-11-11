import { defineStage } from '../../../engine/index.js';
import { stockDigestConfig } from '../config.js';
import { digestPortfolio, digests, sectors } from '../contracts.js';
import { runStockDigestBuild } from './stock-digest-build.js';

export default defineStage({
  name: 'stock-digest-build',
  description:
    'Builds the weekly Claude-narrated markdown digest that is stock-digest\'s final output. It takes ' +
    'two inputs from two different stages, the portfolio snapshot from stock-portfolio-snapshot and ' +
    'the sector map from stock-sector-lookup, and starts only when both have succeeded. All numeric ' +
    'analysis is computed in code rather than left to the model: ' +
    'each position\'s gain since average buy price and share of total portfolio value, a ranked list ' +
    'of top winners and losers, and a grouping of portfolio value by resolved Finnhub industry for a ' +
    'sector-diversification section (left out when no ticker has a resolved industry, and noted ' +
    'in the digest as Finnhub\'s own classification rather than formal GICS). The computed facts are ' +
    'persisted to data/out/stock-digest-facts-<weekKey>.json before the Claude call so they survive on ' +
    'disk even if narration fails. After the model responds, a soft ticker-hallucination cross-check ' +
    'scans the generated markdown for ticker-shaped tokens that don\'t appear in the source holdings ' +
    'and aren\'t a known non-ticker acronym, logging a warning for any found without failing the run. ' +
    'Writes data/out/stock-digest-<weekKey>.md, one file per ISO week, and records one ledger row ' +
    'per week pointing at it, so a re-run in the same week rewrites that week\'s digest in place. ' +
    'No digest is written when the portfolio is empty or when Claude reports a usage limit: both ' +
    'log a warning and leave the existing digests as they were. It reads stock-digest\'s own ' +
    'portfolio snapshot, never anything stocks-sync wrote.',
  timeoutMs: 300_000,
  maxRetries: 3,
  // Two inputs from two different stages. This stage starts only when both the
  // snapshot and the sector lookup have succeeded.
  inputs: {
    portfolio: { artifact: digestPortfolio },
    sectors: { artifact: sectors },
  },
  // One digest per week. A run with nothing held, or one that hit a Claude usage
  // limit, writes none and carries the folder forward.
  outputs: { digests: { artifact: digests, location: () => stockDigestConfig.outDir, cumulative: true } },
  async run(ctx) {
    await runStockDigestBuild(ctx, { portfolioPath: ctx.input('portfolio').path, sectorsPath: ctx.input('sectors').path });
  },
});
