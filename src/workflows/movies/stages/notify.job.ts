import type { JobDefinition } from '../../../core/types.js';
import { recommendationsContract } from '../contracts.js';
import { runNotify } from './notify.js';

const job: JobDefinition = {
  name: 'movie-recs-notify',
  description: 'Terminal stage of the movie-recommendations workflow (T468 — recs-only; the franchise-gap audit that used to share this notify stage now lives in the sibling missing-movies workflow), run once rec-merge finishes. It reads recommendations.json, filters out anything the owner has explicitly ignored via the dashboard (checked against the recs ignore ledger, keyed by TMDB id), and sends one monthly push notification of newly-verified taste-based picks. Idempotency here is a "have I already recommended this?" log rather than a work-done ledger: each recommendation is keyed by TMDB id in the work_items table, so the first run digests the entire current backlog while every later run reports only films newly recommended since the last notification, and an owner-ignored recommendation is suppressed from all future digests (and never re-suggested by rec-merge) until unignored.',
  timeoutMs: 120_000,
  maxRetries: 3,
  consumes: [recommendationsContract()],
  async run(ctx) {
    await runNotify(ctx);
  },
};

export default job;
