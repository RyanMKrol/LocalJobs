import type { JobDefinition } from '../../core/types.js';
import { normalizedPlacesContract, resolvedPlacesContract } from './contracts.js';
import { runResolve } from './resolve.js';

/**
 * Resolve every saved place's CID to a Google place_id (+ coords / featureId /
 * Knowledge-Graph MID) using a headless browser. Reads places.json (from
 * places-ingest) and writes resolved.json. Resumable and rate-limited.
 */
const job: JobDefinition = {
  name: 'cid-to-place-id-resolver',
  description: 'Resolve saved-place CIDs to Google place_ids via a headless browser.',
  timeoutMs: 0, // no job-level timeout; each place is internally bounded + resumable
  maxRetries: 0,
  consumes: [normalizedPlacesContract()],
  produces: [resolvedPlacesContract()],
  async run(ctx) {
    await runResolve(ctx);
  },
};

export default job;
