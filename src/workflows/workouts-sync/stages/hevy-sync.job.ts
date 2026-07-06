import type { JobDefinition } from '../../../core/types.js';
import { runHevySync } from './hevy-sync.js';
import { workoutsHistoryContract } from '../contracts.js';

const job: JobDefinition = {
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
  produces: [workoutsHistoryContract()],
  async run(ctx) {
    await runHevySync(ctx);
  },
};

export default job;
