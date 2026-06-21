import type { JobDefinition } from '../../core/types.js';
import { runResolve } from './resolve.js';

/**
 * Resolve every saved place's CID to a Google place_id (+ coords / featureId /
 * Knowledge-Graph MID) using a headless browser. Reads places.json (from
 * places-ingest) and writes resolved.json. Resumable and rate-limited.
 */
const job: JobDefinition = {
  name: 'cid-to-place-id-resolver',
  description: 'Resolve saved-place CIDs to Google place_ids via a headless browser.',
  instructions: [
    'Prerequisite: run "places-ingest" first so data/out/places.json exists.',
    '',
    'This opens a real (headless) Chrome and visits one Maps page per place to',
    'read its place_id, so it is slow — ~1.5s+ per place, ~1,700 places.',
    'It is RESUMABLE: already-resolved places are skipped, and progress is saved',
    'to resolved.json every 10 places. Safe to run repeatedly until complete.',
    '',
    'Run it from your home network (residential IP) — datacenter IPs get blocked.',
    'For a quick test, set env PLACES_RESOLVE_LIMIT=5 before launching the daemon.',
    '',
    'Output: data/out/resolved.json — { cid: { placeId, lat, lng, featureId, kgMid, status } }',
  ].join('\n'),
  schedule: '0 4 * * 0', // 04:00 every Sunday
  timeoutMs: 0, // no job-level timeout; each place is internally bounded + resumable
  maxRetries: 0,
  async run(ctx) {
    await runResolve(ctx);
  },
};

export default job;
