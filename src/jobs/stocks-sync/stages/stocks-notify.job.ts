import type { JobDefinition } from '../../../core/types.js';
import { runStocksNotify } from './stocks-notify.js';

const job: JobDefinition = {
  name: 'stocks-notify',
  description:
    'Send ONE push naming every position that freshly breached 30%+ above its average buy ' +
    'price this run (per stocks-watch\'s fresh-breaches.json); a no-op when nothing breached.',
  timeoutMs: 60_000,
  maxRetries: 3,
  async run(ctx) {
    await runStocksNotify(ctx);
  },
};

export default job;
