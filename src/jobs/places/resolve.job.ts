import type { JobDefinition } from '../../core/types.js';
import { normalizedPlacesContract, resolvedPlacesContract } from './contracts.js';
import { resolveInputKeys, runResolve } from './resolve.js';

/**
 * Resolve every saved place's CID to a Google place_id (+ coords / featureId /
 * Knowledge-Graph MID) using a headless browser. Reads places.json (from
 * places-ingest) and writes resolved.json. Resumable and rate-limited.
 */
const job: JobDefinition = {
  name: 'cid-to-place-id-resolver',
  description: 'Resolve saved-place CIDs to Google place_ids via a headless browser.',
  timeoutMs: 0, // no job-level timeout; each place is internally bounded + resumable
  maxRetries: 3,
  consumes: [normalizedPlacesContract()],
  produces: [resolvedPlacesContract()],
  // Root stage (T094): each saved-place CID is an originating input. A manual
  // run-limit selects the first N CIDs; downstream stages change the key to
  // place_id but inherit the cid as their root (see enrich/llm markWorkItem).
  inputKeys: resolveInputKeys,
  async run(ctx) {
    await runResolve(ctx);
  },
};

export default job;
