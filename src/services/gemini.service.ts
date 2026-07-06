import type { ServiceDefinition } from '../core/types.js';
import { dailyFromMonthly } from './lib.js';

/** Google Gemini API — PAID. Shared across any job that calls Gemini (today the
 *  LLM place-enrichment). Self-contained: it owns its caps, read from env with the
 *  same defaults the places workflow used to provide (env-overridable via
 *  PLACES_LLM_MONTHLY_CAP / PLACES_LLM_DAILY_CAP). The daily default is monthly/30
 *  (see ./lib.dailyFromMonthly) so a month of daily-scheduled runs fits the
 *  monthly ceiling. The service quota is the single source of the shared spend.
 *  The conservative per-minute rate also respects Gemini's RPM limits. */
const monthlyCap = Number(process.env.PLACES_LLM_MONTHLY_CAP ?? 2000);
const dailyCap = Number(process.env.PLACES_LLM_DAILY_CAP ?? dailyFromMonthly(monthlyCap));

const service: ServiceDefinition = {
  name: 'gemini',
  category: 'api',
  description: 'Google Gemini API (paid). Editorial / LLM enrichment.',
  ratePerMinute: Number(process.env.GEMINI_RATE_PER_MIN ?? 10),
  dailyCap,
  monthlyCap,
  paid: true,
  rateLimitSource:
    'Google\'s published Gemini API rate limits/quotas (verify current tier RPM at ' +
    'https://ai.google.dev/gemini-api/docs/rate-limits). ratePerMinute=10 is set conservatively ' +
    'below the documented tier RPM; dailyCap/monthlyCap are our own personal spend-budget ceiling, ' +
    'not a limit Google enforces.',
};

export default service;
