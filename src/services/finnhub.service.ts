import type { ServiceDefinition } from '../core/types.js';

/**
 * Finnhub — https://finnhub.io — free-tier company metadata API. Used ONLY for
 * `GET /stock/profile2?symbol=<TICKER>&token=<KEY>` to read a ticker's
 * `finnhubIndustry` field (Finnhub's own industry classification, NOT a formal
 * GICS sector) for the stock-digest diversification breakdown. Read-only,
 * GET-only — no mutating calls.
 *
 * Free tier is documented at ~60 calls/minute, comfortably covering a weekly
 * lookup over a personal portfolio's ticker count. This is cheap, low-volume
 * metadata (not a paid-spend-governed call), so the defaults are generous.
 */
const service: ServiceDefinition = {
  name: 'finnhub',
  category: 'api',
  description:
    'Finnhub company-profile API (https://finnhub.io) — read-only lookup of a ticker\'s ' +
    'industry classification for the stock-digest sector breakdown.',
  ratePerMinute: Number(process.env.FINNHUB_RATE_PER_MIN ?? 30),
  dailyCap: Number(process.env.FINNHUB_DAILY_CAP ?? 500),
  monthlyCap: Number(process.env.FINNHUB_MONTHLY_CAP ?? 5_000),
  paid: false,
  rateLimitSource:
    'Finnhub\'s free-tier docs (https://finnhub.io/docs/api/rate-limit) state a ~60 calls/minute ' +
    'limit — verify current figures there before citing a specific number. ratePerMinute=30 sits ' +
    'below that documented ceiling as headroom; dailyCap/monthlyCap are our own conservative ' +
    'estimates on top, not from Finnhub\'s docs.',
};

export default service;
