import type { ServiceDefinition } from '../core/types.js';

/** Last.fm API — free, no published hard rate limit, but requests must remain
 *  friendly. Reads LAST_FM_API_KEY from env. Self-contained — imports nothing
 *  from any workflow. No monetary cost, so no monthlyCap/dailyCap needed; we
 *  pace ourselves to ~30 req/min out of courtesy. */
const service: ServiceDefinition = {
  name: 'lastfm',
  category: 'api',
  description: 'Last.fm API — monthly top-albums/top-tracks listening digest.',
  ratePerMinute: Number(process.env.LASTFM_RATE_PER_MIN ?? 30),
  paid: false,
  rateLimitSource:
    'Last.fm\'s API docs (https://www.last.fm/api) don\'t publish a hard rate limit; the stated ' +
    'convention is to be a "good citizen". ratePerMinute=30 is our own courtesy pacing choice, not ' +
    'a documented ceiling.',
};

export default service;
