import { defineService } from './lib.js';

/** Local filesystem — the owner's own `data/raw/**` files, not a paid or
 *  rate-limited API. Provides call-count metering + per-job consumer tracking
 *  for file-backed data sources. Deliberately declares no ratePerMinute/dailyCap/
 *  monthlyCap/minIntervalMs/maxJitterMs: there is no meaningful rate limit or
 *  spend quota to model for a local disk the owner controls. callService's
 *  existing "no limit configured" branch already falls through to just metering +
 *  recording the call, which is exactly the visibility win wanted here — the same
 *  cross-job tracking as every other shared external dependency. This service
 *  exists purely so a local-file-backed root's inputKeys() can be governed by
 *  the same callService contract as every real external dependency (T487/T488),
 *  with zero carve-outs for "this one just reads a file." */
const service = defineService({
  name: 'fs',
  category: 'local',
  description:
    "The owner's local filesystem (`data/raw/**` files and similar local sources). " +
    'Backs file-read operations for workflows with local data sources.',
  paid: false,
  rateLimitSource:
    'Local filesystem the owner controls — no external rate limit or quota applies; this ' +
    'service exists purely for call-count visibility and per-job consumer tracking on the ' +
    'Integrations page. Local file reads are near-instant.',
});

export default service;
