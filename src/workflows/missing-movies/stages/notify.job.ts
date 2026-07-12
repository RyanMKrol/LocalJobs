import type { JobDefinition } from '../../../core/types.js';
import { franchiseGapsContract } from '../contracts.js';
import { runNotify } from './notify.js';

const job: JobDefinition = {
  name: 'movie-gaps-notify',
  description: 'Terminal stage of the missing-movies workflow, run once franchise-gaps finishes. It reads franchise-gaps.json, filters out anything the owner has explicitly ignored via the dashboard (checked against an ignore ledger keyed by TMDB id), and sends a weekly push notification naming the newly-detected franchise gaps. Idempotency here is a "have I already notified this?" log rather than a work-done ledger: each gap is keyed by TMDB id in the work_items table (job name movie-gaps-notify, unchanged from before the workflow split — no ledger migration needed), so the first run digests the entire current backlog while every later run reports only gaps newly detected since the last notification, and an owner-ignored gap is suppressed from all future digests until unignored.',
  timeoutMs: 120_000,
  maxRetries: 3,
  consumes: [franchiseGapsContract()],
  async run(ctx) {
    await runNotify(ctx);
  },
};

export default job;
