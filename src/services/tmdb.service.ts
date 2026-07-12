import type { ServiceDefinition } from '../core/types.js';

/** The Movie DB API — FREE. Shared by the Plex new-seasons audit (the
 *  tmdb-season-check stage). TMDB has no hard rate limit, but we pace ourselves
 *  as a good citizen (~10/s by default) via a rolling per-minute reservation.
 *  Self-contained: it reads its own rate from env with a sensible default and
 *  imports nothing from a workflow. Not paid, so no daily/monthly quota. */
const service: ServiceDefinition = {
  name: 'tmdb',
  category: 'api',
  description: 'The Movie DB API (free). Season/episode metadata for the Plex new-seasons audit.',
  ratePerMinute: Number(process.env.TMDB_RATE_PER_MIN ?? 600),
  cacheTtlMs: 79_200_000,
  paid: false,
  rateLimitSource:
    'TMDB does not publish a hard rate limit today. ratePerMinute=600 (~10/s) is our own ' +
    'generous-but-cautious pacing choice as a good citizen, not copied from a specific documented ' +
    'number — verify current TMDB API docs before asserting any historical throttling figure.',
};

export default service;
