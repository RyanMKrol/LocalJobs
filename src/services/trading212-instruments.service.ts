import type { ServiceDefinition } from '../core/types.js';

/**
 * Trading212's instruments-metadata endpoint (`fetchInstrumentsMetadata` in
 * `trading212.service.ts`) is a SEPARATE, much more tightly rate-limited endpoint
 * than the portfolio one — 1 request per 50 seconds per Trading212's OpenAPI spec.
 * It gets its OWN service (rather than sharing `trading212`'s `ratePerMinute`
 * budget) so this fixed spacing is enforced mechanically, not just by a code
 * comment telling callers to call it at most once per stage run.
 */
const service: ServiceDefinition = {
  name: 'trading212-instruments',
  category: 'api',
  description:
    'Trading212 instruments-metadata endpoint (https://docs.trading212.com/api) — ' +
    'READ-ONLY lookup only, fixed-spaced per its 1-request-per-50-seconds limit.',
  minIntervalMs: Number(process.env.TRADING212_INSTRUMENTS_MIN_INTERVAL_MS ?? 50_000),
  dailyCap: Number(process.env.TRADING212_INSTRUMENTS_DAILY_CAP ?? 20),
  monthlyCap: Number(process.env.TRADING212_INSTRUMENTS_MONTHLY_CAP ?? 200),
  paid: false,
};

export default service;
