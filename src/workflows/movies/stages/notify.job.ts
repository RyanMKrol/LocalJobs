import type { JobDefinition } from '../../../core/types.js';
import { franchiseGapsContract, recommendationsContract } from '../contracts.js';
import { runNotify } from './notify.js';

const job: JobDefinition = {
  name: 'movie-gaps-notify',
  description: 'Terminal stage of the movie-recommendations workflow, run once both franchise-gaps and rec-merge finish. It reads franchise-gaps.json and recommendations.json, filters out anything the owner has explicitly ignored via the dashboard (checked against separate ignore ledgers for gaps and recommendations, keyed by TMDB id), and sends one combined monthly push notification with two distinct sections — franchise gaps and taste-based recommendations — rather than two separate alerts. Idempotency here is a "have I already notified this?" log rather than a work-done ledger: each gap and recommendation is keyed by TMDB id in the work_items table, so the first run digests the entire current backlog while every later run reports only items that are newly detected or newly recommended since the last notification, and an owner-ignored item is suppressed from all future digests until unignored.',
  timeoutMs: 120_000,
  maxRetries: 3,
  consumes: [franchiseGapsContract(), recommendationsContract()],
  async run(ctx) {
    await runNotify(ctx);
  },
};

export default job;
