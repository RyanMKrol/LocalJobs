import type { JobDefinition } from '../../../core/types.js';
import { runStocksWatch } from './stocks-watch.js';

const job: JobDefinition = {
  name: 'stocks-watch',
  description:
    'Check every held position\'s gain since average buy price and record whether it ' +
    'freshly breached 30%+, writing this run\'s fresh breaches for stocks-notify to send.',
  timeoutMs: 60_000,
  maxRetries: 3,
  async run(ctx) {
    await runStocksWatch(ctx);
  },
};

export default job;
