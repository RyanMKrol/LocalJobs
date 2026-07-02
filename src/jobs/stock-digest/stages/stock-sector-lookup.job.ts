import type { JobDefinition } from '../../../core/types.js';
import { runStockSectorLookup } from './stock-sector-lookup.js';

const job: JobDefinition = {
  name: 'stock-sector-lookup',
  description:
    'Resolve each currently-held ticker\'s industry via the Finnhub company-profile API, ' +
    'idempotent per ticker via the work_items ledger, writing data/out/sectors.json.',
  timeoutMs: 120_000,
  maxRetries: 3,
  async run(ctx) {
    await runStockSectorLookup(ctx);
  },
};

export default job;
