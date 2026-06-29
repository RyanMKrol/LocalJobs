import type { ServiceDefinition } from '../core/types.js';

/**
 * Spotify Web API — Client Credentials flow for album-art enrichment.
 * Calls are free; Spotify's limits are generous. Creds from env:
 *   SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET
 * Enrichment is optional — if these are unset, the job skips it silently.
 */
const service: ServiceDefinition = {
  name: 'spotify',
  description: 'Spotify Web API — album-art enrichment for listens.',
  ratePerMinute: Number(process.env.SPOTIFY_RATE_PER_MIN ?? 30),
  dailyCap: Number(process.env.SPOTIFY_DAILY_CAP ?? 5_000),
  monthlyCap: Number(process.env.SPOTIFY_MONTHLY_CAP ?? 50_000),
  paid: false,
};

export default service;
