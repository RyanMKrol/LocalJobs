import type { ServiceDefinition } from '../../core/types.js';
import { enrichConfig } from './config.js';

/** Google Places API — PAID (free Enterprise+Atmosphere tier = 1000/month). Shared
 *  across any job that hits Places. Caps tied to the job config (env-overridable via
 *  PLACES_ENRICH_DAILY_CAP / PLACES_ENRICH_MONTHLY_CAP) so the service is the single
 *  source of the shared quota. */
const service: ServiceDefinition = {
  name: 'google-places',
  description: 'Google Places API (paid / limited free tier). Place details enrichment.',
  ratePerMinute: Number(process.env.PLACES_RATE_PER_MIN ?? 30),
  dailyCap: enrichConfig.dailyCap,
  monthlyCap: enrichConfig.monthlyCap,
  paid: true,
};

export default service;
