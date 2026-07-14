import { defineService } from './lib.js';

/**
 * Trading212's instruments-metadata endpoint (`fetchInstrumentsMetadata` in
 * `trading212.service.ts`) is a SEPARATE, much more tightly rate-limited endpoint
 * than the portfolio one — 1 request per 50 seconds per Trading212's OpenAPI spec.
 * It gets its OWN service (rather than sharing `trading212`'s `ratePerMinute`
 * budget) so this fixed spacing is enforced mechanically, not just by a code
 * comment telling callers to call it at most once per stage run.
 */
const service = defineService({
  name: 'trading212-instruments',
  category: 'api',
  description:
    'Trading212 instruments-metadata endpoint (https://docs.trading212.com/api) — ' +
    'READ-ONLY lookup only, fixed-spaced per its 1-request-per-50-seconds limit.',
  envPrefix: 'TRADING212_INSTRUMENTS',
  minIntervalMs: { fallback: 50_000 },
  dailyCap: { fallback: 20 },
  monthlyCap: { fallback: 200 },
  cacheTtlMs: 79_200_000,
  paid: false,
  rateLimitSource:
    'Documented in Trading212\'s OpenAPI spec (https://docs.trading212.com/api): the ' +
    'instruments-metadata endpoint is limited to 1 request per 50 seconds. minIntervalMs=50,000 ' +
    'mirrors that documented limit exactly; dailyCap/monthlyCap are our own defensive estimates on ' +
    'top.',
});

export default service;
