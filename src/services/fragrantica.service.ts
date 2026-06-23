import type { ServiceDefinition } from '../core/types.js';

/** Fragrantica scraping — free, but Cloudflare blocks bursts. Governed by a
 *  FIXED min-interval (not a burst-y rate): the ~12s spacing we proved, plus
 *  jitter. Self-contained: reads the SAME env the perfumes fetch stage uses
 *  (PERFUMES_FETCH_DELAY_MS / PERFUMES_FETCH_JITTER_MS) with identical defaults,
 *  so behaviour and `.env` are unchanged — but it imports nothing from a workflow.
 *
 *  This is the *pacing* half of the reputation-gate strategy; the *launch* half
 *  (persistent profile + real-Chrome channel) lives in `core/browser`. Both are
 *  needed: reputable cookies AND human-paced timing. */
const service: ServiceDefinition = {
  name: 'fragrantica',
  description: 'Fragrantica page fetches (headless). Free; fixed-spacing to dodge Cloudflare.',
  minIntervalMs: Number(process.env.PERFUMES_FETCH_DELAY_MS ?? 12_000),
  maxJitterMs: Number(process.env.PERFUMES_FETCH_JITTER_MS ?? 6000),
  paid: false,
};

export default service;
