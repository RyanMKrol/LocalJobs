import type { JobDefinition } from '../../../core/types.js';
import { runWorkoutsProgress } from './workouts-progress.js';

const job: JobDefinition = {
  name: 'workouts-progress',
  description:
    'Compute a per-exercise 6-month progress comparison (best set / volume / est. 1RM) from the ' +
    'local workouts history and write a Claude-narrated markdown report. Idempotent per calendar month.',
  timeoutMs: 300_000,
  maxRetries: 3,
  async run(ctx) {
    await runWorkoutsProgress(ctx);
  },
};

export default job;
