import { defineService } from './lib.js';

/** Plex Media Server — the owner's own local LAN server, not a paid API, but
 *  paced at a conservative 300 req/min to protect the box under a full-library
 *  crawl (folded in from a long-standing dashboard override — overrides-audit
 *  flagged it as stale/unfolded; the owner confirmed the limit itself is
 *  intentional and should become the code default). No dailyCap/monthlyCap/
 *  minIntervalMs/maxJitterMs: there is no spend quota to model for a local
 *  server the owner controls, just a rate ceiling. Shared by every
 *  Plex-touching workflow via ../core/plex-client.ts. */
const service = defineService({
  name: 'plex',
  category: 'api',
  description:
    "The owner's local Plex Media Server (LAN-hosted, not a paid or externally rate-limited API). " +
    'Backs library/media metadata reads for the Plex-touching workflows.',
  paid: false,
  ratePerMinute: { env: 'PLEX_RATE_PER_MIN', fallback: 300 },
  rateLimitSource:
    'Local LAN server the owner runs — no external rate limit or quota applies; the ' +
    '300/min ceiling is our own conservative pacing choice to protect the box under a ' +
    'full-library crawl, not a published vendor limit.',
  // Matches plex-client.ts's own PLEX_REQUEST_TIMEOUT_MS env-var default (T465) — kept
  // in sync so the code default is the same whether read via the env var or this
  // ServiceDefinition. Dashboard-editable via effectiveServiceTimeoutMs('plex', ...).
  timeoutMs: 300_000,
  // 3-hour cache TTL for Plex responses (T476). A full-library crawl is expensive,
  // and Plex library contents change slowly enough that multi-hour-stale cache is
  // acceptable, unlike TMDB's cheaper per-lookup calls which keep the 5-minute
  // global default.
  cacheTtlMs: 3 * 60 * 60 * 1000,
});

export default service;
