import type { JobDefinition } from '../../../core/types.js';
import { stocksFreshBreachesContract } from '../contracts.js';
import { runStocksNotify } from './stocks-notify.js';

const job: JobDefinition = {
  name: 'stocks-notify',
  description:
    'The terminal stage of the stocks-sync DAG: reads data/out/fresh-breaches.json written by ' +
    'stocks-watch and, if it lists any positions, sends a single combined push notification ' +
    'naming every position that freshly breached 30%+ gain above its average buy price this run ' +
    '(multiple breaches are folded into one push, never one per position). When the file is empty ' +
    'this stage is a genuine no-op — the only stage in this workflow where doing nothing is the ' +
    'correct, expected outcome, since stocks-watch always records real ledger activity every run ' +
    'regardless of whether anything actually breached. Because it has no work-item ledger of its ' +
    'own, the workflow manifest points the dashboard\'s Output section at stocks-snapshot instead ' +
    '(outputJob).',
  timeoutMs: 60_000,
  maxRetries: 3,
  consumes: [stocksFreshBreachesContract()],
  async run(ctx) {
    await runStocksNotify(ctx);
  },
};

export default job;
