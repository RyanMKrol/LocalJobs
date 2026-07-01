import type { ServiceDefinition } from '../core/types.js';

/**
 * Trading212 Public API — https://docs.trading212.com/api
 *
 * READ-ONLY use only, always — see the root CLAUDE.md "Broker / trading APIs are
 * READ-ONLY, always" rule and src/services/CLAUDE.md. This service must NEVER issue
 * a mutating (POST/PUT/PATCH/DELETE) request to Trading212.
 *
 * Free API; Trading212 rate-limits per-endpoint (portfolio is roughly 1 req/sec on
 * their side). We poll infrequently (daily), so conservative limits are far below
 * any real ceiling.
 */
const service: ServiceDefinition = {
  name: 'trading212',
  description:
    'Trading212 Public API (https://docs.trading212.com/api) — READ-ONLY portfolio ' +
    'fetch only. No mutating requests are ever made.',
  ratePerMinute: Number(process.env.TRADING212_RATE_PER_MIN ?? 10),
  dailyCap: Number(process.env.TRADING212_DAILY_CAP ?? 100),
  monthlyCap: Number(process.env.TRADING212_MONTHLY_CAP ?? 1_000),
  paid: false,
};

export default service;
