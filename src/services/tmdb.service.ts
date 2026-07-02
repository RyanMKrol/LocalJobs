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
  paid: false,
};

export default service;
