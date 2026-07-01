import type { JobDefinition } from '../../../core/types.js';
import { runStocksWatch } from './stocks-watch.js';

const job: JobDefinition = {
  name: 'stocks-watch',
  description:
    'Notify once when a held position\'s current price is 30% or more above its average buy ' +
    'price, resetting so a later re-breach after dropping back below 30% notifies again.',
  timeoutMs: 60_000,
  maxRetries: 3,
  async run(ctx) {
    await runStocksWatch(ctx);
  },
};

export default job;
