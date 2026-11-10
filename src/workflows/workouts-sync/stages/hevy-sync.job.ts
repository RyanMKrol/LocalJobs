import { existsSync } from 'node:fs';
import { defineStage } from '../../../engine/index.js';
import { workoutsHistory } from '../contracts.js';
import { defaultHistoryPath, runHevySync } from './hevy-sync.js';

export default defineStage({
  name: 'hevy-sync',
  description:
    'Pages through the Hevy workout API (https://api.hevyapp.com/v1/workouts), fetching workouts ' +
    'in batches and stopping once it reaches ones already recorded. Requests are rate-limited via ' +
    'the shared hevy service (src/services/hevy.service.ts), which coordinates call pacing across ' +
    'jobs so this stays within Hevy\'s API limits. Idempotent per workout via the work_items ' +
    'ledger, keyed by Hevy workout id: only workouts not already synced are appended, so already- ' +
    'synced ids are skipped on re-runs. Each new workout\'s full data — title, its exercises, and ' +
    'every logged set (weight, reps, etc.) — is appended to a local full-history JSON file ' +
    '(data/out/workouts-history.json), which only ever grows and is never rewritten or pruned.',
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
