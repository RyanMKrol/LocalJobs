import type { JobDefinition } from '../../core/types.js';
import { enrichedPlacesContract, resolvedPlacesContract } from './contracts.js';
import { runEnrich } from './enrich.js';

/**
 * Enrich resolved places with Google Places API details (rating, hours, cuisine,
 * price, reviews, summary…). Incremental, budget-capped to the free tier, and
 * scheduled weekly to chip away at the backlog without ever incurring charges.
 */
const job: JobDefinition = {
  name: 'places-enrich',
  description: 'Enrich resolved places via the Google Places API (free-tier budgeted, weekly).',
  timeoutMs: 0, // budget-capped + each call bounded; no job-level timeout
  maxRetries: 3,
  consumes: [resolvedPlacesContract()],
  produces: [enrichedPlacesContract()],
  async run(ctx) {
    await runEnrich(ctx);
  },
};

export default job;
