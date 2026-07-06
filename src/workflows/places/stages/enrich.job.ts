import type { JobDefinition } from '../../../core/types.js';
import { enrichedPlacesContract, resolvedPlacesContract } from '../contracts.js';
import { runEnrich } from './enrich.js';

/**
 * Enrich resolved places with Google Places API details (rating, hours, cuisine,
 * price, reviews, summary…). Incremental, budget-capped to the free tier, and
 * scheduled weekly to chip away at the backlog without ever incurring charges.
 */
const job: JobDefinition = {
  name: 'places-enrich',
  description:
    'The third stage of the places workflow. It reads data/out/resolved.json (written by cid-to-place-id-resolver) and, for ' +
    'each resolved place_id not already enriched, fetches full Place Details (New) from the Google Places API using a ' +
    'wildcard field mask, storing the raw response (rating, hours, cuisine, price, reviews, summary, and more) in ' +
    'data/out/enriched.json. It is incremental — a place that enriched successfully is never re-enriched on a later run — ' +
    'and spend is governed solely by the shared google-places service quota: when the quota is exhausted the run stops ' +
    'gracefully rather than throwing, leaving remaining places for a future run. Requires GOOGLE_MAPS_API_KEY. The workflow ' +
    'schedules this daily, and the service quota daily cap is a thirtieth of its monthly cap so a full month of daily runs ' +
    'exactly fits the monthly ceiling without ever overspending.',
  timeoutMs: 0, // budget-capped + each call bounded; no job-level timeout
  maxRetries: 3,
  consumes: [resolvedPlacesContract()],
  produces: [enrichedPlacesContract()],
  async run(ctx) {
    await runEnrich(ctx);
  },
};

export default job;
