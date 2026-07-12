import type { JobDefinition } from '../../../core/types.js';
import { recommendationsContract } from '../contracts.js';
import { runNotify } from './notify.js';

const job: JobDefinition = {
  name: 'movie-recs-notify',
  description: 'Terminal stage of the movie-recommendations workflow, run once rec-merge finishes. It reads recommendations.json, filters out anything the owner has explicitly ignored via the dashboard (checked against the recommendations ignore ledger, keyed by TMDB id), and sends a monthly push notification with the newly-surfaced taste-based recommendations. Idempotency here is a "have I already recommended this?" log rather than a work-done ledger: each recommendation is keyed by TMDB id in the work_items table, so the first run digests the entire current pool while every later run reports only films newly recommended since the last notification, and an owner-ignored recommendation is suppressed from all future digests until unignored. (The separate franchise-gap digest moved to the missing-movies workflow\'s own movie-gaps-notify job.)',
  timeoutMs: 120_000,
  maxRetries: 3,
  consumes: [recommendationsContract()],
  async run(ctx) {
    await runNotify(ctx);
  },
};

export default job;
