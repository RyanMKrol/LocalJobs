import type { JobDefinition } from '../../../core/types.js';
import { runHevySync } from './hevy-sync.js';

const job: JobDefinition = {
  name: 'hevy-sync',
  description:
    'Paginate the Hevy API and append new workouts to a local full-history JSON file. ' +
    'Idempotent via the work_items ledger (keyed by Hevy workout id).',
  timeoutMs: 300_000,
  maxRetries: 3,
  async run(ctx) {
    await runHevySync(ctx);
  },
};

export default job;
