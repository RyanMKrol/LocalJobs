import { defineService } from './lib.js';

/** Last.fm API — free, no published hard rate limit, but requests must remain
 *  friendly. Reads LAST_FM_API_KEY from env. Self-contained — imports nothing
 *  from any workflow. No monetary cost, so no monthlyCap/dailyCap needed; we
 *  pace ourselves to ~30 req/min out of courtesy. */
const service = defineService({
  name: 'lastfm',
  category: 'api',
  description: 'Last.fm API — monthly top-albums/top-tracks listening digest.',
  envPrefix: 'LASTFM',
  ratePerMinute: { fallback: 30 },
  cacheTtlMs: 79_200_000,
  paid: false,
  rateLimitSource:
    'Last.fm\'s API docs (https://www.last.fm/api) don\'t publish a hard rate limit; the stated ' +
    'convention is to be a "good citizen". ratePerMinute=30 is our own courtesy pacing choice, not ' +
    'a documented ceiling.',
});

export default service;
