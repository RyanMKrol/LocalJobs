import type { JobDefinition } from '../../../core/types.js';
import { runWorkoutsProgress } from './workouts-progress.js';
import { workoutsHistoryContract } from '../contracts.js';

const job: JobDefinition = {
  name: 'workouts-progress',
  description:
    'Reads the full workouts history file and computes, per exercise, a comparison between a ' +
    'baseline period (the calendar month exactly 6 months before the current period) and the ' +
    'current period (the most recently completed calendar month), across three metrics: the best ' +
    'single set (highest weight_kg, ties broken by reps), total volume (sum of weight_kg * reps ' +
    'across all sets), and an estimated one-rep max using the Epley formula (weight_kg * (1 + ' +
    'reps / 30), taking the max across the period). Sets with a null weight_kg or reps (duration- ' +
    'or distance-based exercises) are skipped from all three metrics, and an exercise with no ' +
    'usable sets in either period is excluded entirely. The raw comparison is written to ' +
    'data/out/progress-data.json, then handed to the shared Claude CLI helper ' +
    '(src/services/claude.ts) to narrate into a readable markdown report at ' +
    'data/out/workouts-progress.md. Idempotent per calendar month via the work_items ledger: a ' +
    'manual re-run within the same month regenerates the report under the same static filename ' +
    'rather than duplicating it.',
  timeoutMs: 300_000,
  maxRetries: 3,
  consumes: [workoutsHistoryContract()],
  async run(ctx) {
    await runWorkoutsProgress(ctx);
  },
};

export default job;
