import type { JobDefinition } from '../../../core/types.js';
import { stockDigestPortfolioContract, stockSectorsContract } from '../contracts.js';
import { runStockSectorLookup } from './stock-sector-lookup.js';

const job: JobDefinition = {
  name: 'stock-sector-lookup',
  description:
    'Resolves each currently-held ticker\'s industry classification via the Finnhub company-profile ' +
    'API, preferring the OpenFIGI-resolved real-world ticker produced by stock-portfolio-snapshot ' +
    'over Trading212\'s own raw ticker (T373) — falling back to a crude string-strip of a trailing ' +
    'market/country suffix only when no resolved ticker exists, since a stale raw ticker can return ' +
    'an empty Finnhub profile. Each ticker\'s lookup is idempotent via the work_items ledger: a ' +
    'resolved industry is never re-queried on a later run, while an unresolved lookup is recorded as ' +
    'failed so it retries (surfacing on the Stuck tile if it never resolves). Writes the resulting ' +
    'ticker-to-industry map to data/out/sectors.json, feeding stock-digest-build\'s sector-' +
    'diversification section. If FINNHUB_API_KEY is unset the whole stage soft-skips with a clear ' +
    'warning, and that run\'s digest simply omits the diversification section.',
  timeoutMs: 120_000,
  maxRetries: 3,
  consumes: [stockDigestPortfolioContract()],
  produces: [stockSectorsContract()],
  async run(ctx) {
    await runStockSectorLookup(ctx);
  },
};

export default job;
