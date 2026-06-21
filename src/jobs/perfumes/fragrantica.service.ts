import type { ServiceDefinition } from '../../core/types.js';
import { perfumesConfig } from './config.js';

/** Fragrantica scraping — free, but Cloudflare blocks bursts. Governed by a
 *  FIXED min-interval (not a burst-y rate): the ~12s spacing we proved, plus
 *  jitter. Env-tunable via PERFUMES_FETCH_DELAY_MS / PERFUMES_FETCH_JITTER_MS.
 *
 *  This is the *pacing* half of the reputation-gate strategy; the *launch* half
 *  (persistent profile + real-Chrome channel) lives in `core/browser`. Both are
 *  needed: reputable cookies AND human-paced timing. */
const service: ServiceDefinition = {
  name: 'fragrantica',
  description: 'Fragrantica page fetches (headless). Free; fixed-spacing to dodge Cloudflare.',
  minIntervalMs: perfumesConfig.fetchDelayMs,
  maxJitterMs: perfumesConfig.fetchJitterMs,
  paid: false,
};

export default service;
