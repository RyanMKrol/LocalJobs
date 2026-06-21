import type { ServiceDefinition } from '../../core/types.js';
import { llmConfig } from './config.js';

/** Google Gemini API — PAID. Shared across any job that calls Gemini (today the
 *  LLM place-enrichment). Caps are tied to the job config (env-overridable via
 *  PLACES_LLM_DAILY_CAP / PLACES_LLM_MONTHLY_CAP), so the service is the single
 *  source of the shared quota. The conservative per-minute rate also respects
 *  Gemini's RPM limits. */
const service: ServiceDefinition = {
  name: 'gemini',
  description: 'Google Gemini API (paid). Editorial / LLM enrichment.',
  ratePerMinute: Number(process.env.GEMINI_RATE_PER_MIN ?? 10),
  dailyCap: llmConfig.dailyCap,
  monthlyCap: llmConfig.monthlyCap,
  paid: true,
};

export default service;
