import type { ServiceDefinition } from '../core/types.js';

/** Spotify Web API — free Client Credentials flow, no per-user OAuth needed for
 *  album/track metadata. Reads SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET from
 *  env. Self-contained — imports nothing from any workflow. No monetary cost;
 *  Spotify's documented rate limit is ~180 req/min; we stay well under that. */
const service: ServiceDefinition = {
  name: 'spotify',
  description: 'Spotify Web API — album art enrichment for listens-sync.',
  ratePerMinute: Number(process.env.SPOTIFY_RATE_PER_MIN ?? 60),
  paid: false,
};

export default service;
