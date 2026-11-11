import { existsSync } from 'node:fs';
import { defineStage } from '../../../engine/index.js';
import { workoutsHistory } from '../contracts.js';
import { defaultHistoryPath, runHevySync } from './hevy-sync.js';

export default defineStage({
  name: 'hevy-sync',
  description:
    'Pages through the whole Hevy workout list (https://api.hevyapp.com/v1/workouts), ten ' +
    'workouts per page, reading every page on every run. Requests are rate-limited via the shared ' +
    'hevy service (src/services/hevy.service.ts), which coordinates call pacing across jobs so ' +
    'this stays within Hevy\'s API limits. Each workout is tracked in the work_items ledger, keyed ' +
    'by Hevy workout id, so a workout that is already synced is skipped and only new ones are ' +
    'added. Each new workout\'s full data (its title, its exercises, and every logged set with ' +
    'weight, reps and so on) is added to a local full-history JSON file ' +
    '(data/out/workouts-history.json), which grows over time and is never pruned. The file is ' +
    'saved, atomically, before the workouts are marked synced in the ledger, so a run killed in ' +
    'between cannot leave a workout marked done but missing from the history; the save replaces ' +
    'by workout id, so a workout synced twice after such a kill is not duplicated. On a fresh ' +
    'install with nothing to sync the stage commits an empty history.',
  timeoutMs: 300_000,
  maxRetries: 3,
  // The history grows as workouts are synced: a run with nothing new carries it forward.
  outputs: {
    history: { artifact: workoutsHistory, location: () => defaultHistoryPath, cumulative: true },
  },
  describeItem: (d) => ({
    title: String(d.name ?? ''),
    fields: [
      ...(typeof d.startTime === 'string' ? [{ label: 'Date', value: d.startTime.slice(0, 10) }] : []),
      ...(d.exerciseCount != null ? [{ label: 'Exercises', value: String(d.exerciseCount) }] : []),
      ...(d.setCount != null ? [{ label: 'Sets', value: String(d.setCount) }] : []),
      ...(typeof d.error === 'string' ? [{ label: 'Error', value: d.error.slice(0, 160) }] : []),
    ],
  }),
  async run(ctx) {
    const history = ctx.output('history');
    await runHevySync(ctx, { historyPath: history.path });
    // The history is this stage's output, so it exists from the first run on:
    // before any workout has ever been synced, it is an empty list.
    if (!existsSync(history.path)) history.write([]);
  },
});
