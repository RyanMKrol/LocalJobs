import { defineStage } from '../../../engine/index.js';
import { placesConfig } from '../config.js';
import { enrichedPlaces, resolvedPlaces } from '../contracts.js';
import { runEnrich } from './enrich.js';

/**
 * Enrich resolved places with Google Places API details (rating, hours, cuisine,
 * price, reviews, summary…). Incremental and capped by the google-places service
 * quota, so the daily run works through the backlog inside the free tier.
 */
export default defineStage({
  name: 'places-enrich',
  description:
    'The third stage of the places workflow. It reads data/out/resolved.json (written by cid-to-place-id-resolver) and, for ' +
    'each resolved place_id not already enriched, fetches full Place Details (New) from the Google Places API using a ' +
    'wildcard field mask, storing the raw response (rating, hours, cuisine, price, reviews, summary, and more) in ' +
    'data/out/enriched.json. It is incremental: a place that enriched successfully is never enriched again on a later run. ' +
    'Spend is governed solely by the shared google-places service quota: when the quota is exhausted the run stops ' +
    'gracefully rather than throwing, leaving remaining places for a future run. A bad key, a disabled API or depleted ' +
    'billing fails the run instead, since no later run would get past it. Requires GOOGLE_MAPS_API_KEY. The workflow ' +
    'schedules this daily, and the service quota daily cap is a thirtieth of its monthly cap so a full month of daily runs ' +
    'exactly fits the monthly ceiling without ever overspending.',
  timeoutMs: 0, // budget-capped + each call bounded; no job-level timeout
  maxRetries: 3,
  inputs: { resolved: { artifact: resolvedPlaces } },
  // The details store grows as places are enriched: a run with nothing left to
  // enrich, or one stopped by the quota, carries it forward.
  outputs: {
    enriched: { artifact: enrichedPlaces, location: () => placesConfig.enrichedOut, cumulative: true },
  },
  async run(ctx) {
    await runEnrich(ctx);
  },
});
