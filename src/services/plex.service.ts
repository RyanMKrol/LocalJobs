import { defineService } from './lib.js';

/** Plex Media Server — the owner's own local LAN server, not a paid or
 *  rate-limited API. Shared by every Plex-touching workflow via
 *  ../core/plex-client.ts. Deliberately declares no ratePerMinute/dailyCap/
 *  monthlyCap/minIntervalMs/maxJitterMs: there is no meaningful rate limit or
 *  spend quota to model for a local server the owner controls. callService's
 *  existing "no limit configured" branch already falls through to just
 *  metering + recording the call, which is exactly the visibility win wanted
 *  here — call-count metering and per-job consumer tracking on the
 *  Integrations page, matching every other shared external dependency. */
const service = defineService({
  name: 'plex',
  category: 'api',
  description:
    "The owner's local Plex Media Server (LAN-hosted, not a paid or rate-limited API). " +
    'Backs library/media metadata reads for the Plex-touching workflows.',
  paid: false,
  rateLimitSource:
    'Local LAN server the owner runs — no external rate limit or quota applies; this ' +
    'service exists purely for call-count visibility and per-job consumer tracking on the ' +
    'Integrations page.',
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
