import type { JobDefinition } from '../../../core/types.js';
import { stockDigestPortfolioContract, stockSectorsContract } from '../contracts.js';
import { runStockDigestBuild } from './stock-digest-build.js';

const job: JobDefinition = {
  name: 'stock-digest-build',
  description:
    'Build a weekly Claude-narrated markdown digest of current stock holdings + performance movers, ' +
    'reading stock-digest\'s own portfolio snapshot (independent of stocks-sync). Idempotent per ISO ' +
    'week via the work_items ledger.',
  timeoutMs: 300_000,
  maxRetries: 3,
  consumes: [stockDigestPortfolioContract(), stockSectorsContract()],
  async run(ctx) {
    await runStockDigestBuild(ctx);
  },
};

export default job;
