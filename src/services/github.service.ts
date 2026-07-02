import type { ServiceDefinition } from '../core/types.js';

/**
 * GitHub REST API — personal account repos fetch. Free API; authenticated
 * requests get 5 000 req/hr. We fetch repos infrequently (daily), so conservative
 * limits are far below GitHub's ceiling.
 *
 * Reads GITHUB_TOKEN from env (a personal access token with at least `public_repo`
 * scope). Without a token requests are unauthenticated (60 req/hr) — fine for
 * occasional use but document the var so the owner knows to set it.
 */
const service: ServiceDefinition = {
  name: 'github',
  category: 'api',
  description: 'GitHub REST API — fetch user repos, rate-limited conservatively.',
  ratePerMinute: Number(process.env.GITHUB_RATE_PER_MIN ?? 30),
  dailyCap: Number(process.env.GITHUB_DAILY_CAP ?? 200),
  monthlyCap: Number(process.env.GITHUB_MONTHLY_CAP ?? 3_000),
  paid: false,
};

export default service;
