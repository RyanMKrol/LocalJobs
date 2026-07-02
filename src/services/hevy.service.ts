import type { ServiceDefinition } from '../core/types.js';

/**
 * Hevy workout API — personal fitness tracker. Free API, no published rate limits,
 * but we keep calls conservative: sync is infrequent, never time-sensitive.
 * Reads HEVY_API_KEY from env (set by the user; no default — will throw at runtime
 * if missing when the workout-sync job tries to call it).
 */
const service: ServiceDefinition = {
  name: 'hevy',
  category: 'api',
  description: 'Hevy workout API — paginated workout ingestion.',
  ratePerMinute: Number(process.env.HEVY_RATE_PER_MIN ?? 20),
  dailyCap: Number(process.env.HEVY_DAILY_CAP ?? 500),
  monthlyCap: Number(process.env.HEVY_MONTHLY_CAP ?? 5_000),
  paid: false,
};

export default service;
