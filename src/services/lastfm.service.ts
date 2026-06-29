import type { ServiceDefinition } from '../core/types.js';

/** Last.fm API — free, no published hard rate limit, but requests must remain
 *  friendly. Reads LAST_FM_API_KEY from env. Self-contained — imports nothing
 *  from any workflow. No monetary cost, so no monthlyCap/dailyCap needed; we
 *  pace ourselves to ~30 req/min out of courtesy. */
const service: ServiceDefinition = {
  name: 'lastfm',
  description: 'Last.fm API — recent-tracks scrobble ingestion.',
  ratePerMinute: Number(process.env.LASTFM_RATE_PER_MIN ?? 30),
  paid: false,
};

export default service;
