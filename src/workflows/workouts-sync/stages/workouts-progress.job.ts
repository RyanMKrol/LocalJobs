import { resolve } from 'node:path';
import { defineStage } from '../../../engine/index.js';
import { progressData, progressReports, workoutsHistory } from '../contracts.js';
import { defaultOutDir, runWorkoutsProgress } from './workouts-progress.js';

export default defineStage({
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
    'data/out/workouts-progress-<YYYY-MM>.md — one file per month, so past reports survive. ' +
    "Claude's reply is passed through salvageReport, which drops any leaked preamble before the " +
    'first markdown heading and fails the run (for retry) when no heading exists. Idempotent per ' +
    'calendar month via the work_items ledger: a manual re-run within the same month regenerates ' +
    "that month's file rather than duplicating it.",
  timeoutMs: 300_000,
  maxRetries: 3,
  inputs: { history: { artifact: workoutsHistory } },
  outputs: {
    // Recomputed from the whole history on every run.
    data: { artifact: progressData, location: () => resolve(defaultOutDir, 'progress-data.json') },
    // One report per month. A run that hit a Claude usage limit writes none and
    // carries the folder forward; the next run writes this month's.
    reports: { artifact: progressReports, location: () => defaultOutDir, cumulative: true },
  },
  async run(ctx) {
    await runWorkoutsProgress(ctx, { historyPath: ctx.input('history').path });
  },
});
