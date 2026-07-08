import type { ServiceDefinition } from '../core/types.js';

/** Plex Media Server — the owner's own local LAN server, not a paid or
 *  rate-limited API. Shared by every Plex-touching workflow via
 *  ../core/plex-client.ts. Deliberately declares no ratePerMinute/dailyCap/
 *  monthlyCap/minIntervalMs/maxJitterMs: there is no meaningful rate limit or
 *  spend quota to model for a local server the owner controls. callService's
 *  existing "no limit configured" branch already falls through to just
 *  metering + recording the call, which is exactly the visibility win wanted
 *  here — call-count metering and per-job consumer tracking on the
 *  Integrations page, matching every other shared external dependency. */
const service: ServiceDefinition = {
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
};

export default service;
