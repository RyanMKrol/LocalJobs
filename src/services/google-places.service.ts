import type { ServiceDefinition } from '../core/types.js';
import { dailyFromMonthly } from './lib.js';

/** Google Places API — PAID (free Enterprise+Atmosphere tier = 1000/month). Shared
 *  across any job that hits Places. Self-contained: it owns its caps, read from env
 *  with the same defaults the places workflow used to provide (env-overridable via
 *  PLACES_ENRICH_MONTHLY_CAP / PLACES_ENRICH_DAILY_CAP). The daily default is
 *  monthly/30 (see ./lib.dailyFromMonthly) so a month of daily-scheduled runs fits
 *  the monthly ceiling. The service quota is the single source of the shared spend. */
const monthlyCap = Number(process.env.PLACES_ENRICH_MONTHLY_CAP ?? 1000);
const dailyCap = Number(process.env.PLACES_ENRICH_DAILY_CAP ?? dailyFromMonthly(monthlyCap));

const service: ServiceDefinition = {
  name: 'google-places',
  category: 'api',
  description: 'Google Places API (paid / limited free tier). Place details enrichment.',
  ratePerMinute: Number(process.env.PLACES_RATE_PER_MIN ?? 30),
  dailyCap,
  monthlyCap,
  paid: true,
  rateLimitSource:
    'Google Places API pricing/quota docs ' +
    '(https://developers.google.com/maps/documentation/places/web-service/usage-and-billing); ' +
    'monthlyCap=1000 mirrors the free Enterprise+Atmosphere tier\'s documented monthly allowance. ' +
    'ratePerMinute=30 is our own conservative pacing choice, not a published RPM limit.',
};

export default service;
