import { defineService } from './lib.js';

/**
 * GitHub REST API — personal account repos fetch. Free API; authenticated
 * requests get 5 000 req/hr. We fetch repos infrequently (daily), so conservative
 * limits are far below GitHub's ceiling.
 *
 * Reads GITHUB_TOKEN from env (a personal access token with at least `public_repo`
 * scope). Without a token requests are unauthenticated (60 req/hr) — fine for
 * occasional use but document the var so the owner knows to set it.
 */
const service = defineService({
  name: 'github',
  category: 'api',
  description: 'GitHub REST API — fetch user repos, rate-limited conservatively.',
  envPrefix: 'GITHUB',
  ratePerMinute: { fallback: 30 },
  dailyCap: { fallback: 200 },
  monthlyCap: { fallback: 3_000 },
  cacheTtlMs: 79_200_000,
  paid: false,
  rateLimitSource:
    'Documented in GitHub\'s REST API docs ' +
    '(https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api): ' +
    '5,000 req/hr authenticated, 60 req/hr unauthenticated. ratePerMinute=30 / dailyCap=200 / ' +
    'monthlyCap=3,000 are well below that documented ceiling — conservative headroom, not a guess ' +
    'about the ceiling itself.',
});

export default service;
