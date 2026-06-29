import type { ServiceDefinition } from '../core/types.js';

/**
 * Last.fm API — free, unauthenticated read-only access for scrobble history.
 * No published rate limit; we self-throttle conservatively. Creds from env:
 *   LAST_FM_API_KEY  — required for API calls.
 */
const service: ServiceDefinition = {
  name: 'lastfm',
  description: 'Last.fm API — scrobble history via user.getRecentTracks.',
  ratePerMinute: Number(process.env.LASTFM_RATE_PER_MIN ?? 30),
  dailyCap: Number(process.env.LASTFM_DAILY_CAP ?? 2_000),
  monthlyCap: Number(process.env.LASTFM_MONTHLY_CAP ?? 30_000),
  paid: false,
};

export default service;
