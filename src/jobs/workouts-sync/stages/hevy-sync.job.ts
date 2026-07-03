import type { JobDefinition } from '../../../core/types.js';
import { runHevySync } from './hevy-sync.js';
import { workoutsHistoryContract } from '../contracts.js';

const job: JobDefinition = {
  name: 'hevy-sync',
  description:
    'Paginate the Hevy API and append new workouts to a local full-history JSON file. ' +
    'Idempotent via the work_items ledger (keyed by Hevy workout id).',
  timeoutMs: 300_000,
  maxRetries: 3,
  produces: [workoutsHistoryContract()],
  async run(ctx) {
    await runHevySync(ctx);
  },
};

export default job;
