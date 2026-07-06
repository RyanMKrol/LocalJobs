import type { JobDefinition } from '../../../core/types.js';
import { normalizedPlacesContract, resolvedPlacesContract } from '../contracts.js';
import { resolveInputKeys, runResolve } from './resolve.js';

/**
 * Resolve every saved place's CID to a Google place_id (+ coords / featureId /
 * Knowledge-Graph MID) using a headless browser. Reads places.json (from
 * places-ingest) and writes resolved.json. Resumable and rate-limited.
 */
const job: JobDefinition = {
  name: 'cid-to-place-id-resolver',
  description:
    'The second stage of the places workflow. It reads data/out/places.json (written by places-ingest) and, for each not-yet-' +
    "resolved CID, drives a headless browser to https://www.google.com/maps?cid=<cid> to resolve the venue's opaque CID to " +
    'a real Google place_id, along with its coordinates, feature id, and Knowledge Graph MID where available. Results are ' +
    'written to data/out/resolved.json. It is free (no paid API), resumable across runs via the work_items ledger, and ' +
    'paced with a delay between requests (PLACES_RESOLVE_DELAY_MS, default 1500ms) to avoid tripping Google reputation ' +
    'gating; its own monthly/daily counters (PLACES_RESOLVE_MONTHLY_CAP/_DAILY_CAP) are a politeness/runaway guard, not a ' +
    'spend cap. This is the workflow root stage: it declares inputKeys(), so a manual run-limit selects the first N CIDs ' +
    'here, and every later stage inherits the CID as its lineage root even after re-keying to place_id.',
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
