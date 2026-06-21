import type { JobDefinition } from '../../core/types.js';
import { runEnrich } from './enrich.js';

/**
 * Enrich resolved places with Google Places API details (rating, hours, cuisine,
 * price, reviews, summary…). Incremental, budget-capped to the free tier, and
 * scheduled weekly to chip away at the backlog without ever incurring charges.
 */
const job: JobDefinition = {
  name: 'places-enrich',
  description: 'Enrich resolved places via the Google Places API (free-tier budgeted, weekly).',
  instructions: [
    'Prerequisite: run "cid-to-place-id-resolver" first so data/out/resolved.json exists.',
    '',
    'One-time setup — get a Google Maps Platform API key:',
    '  1. console.cloud.google.com → create/select a project.',
    '  2. Enable the "Places API (New)".',
    '  3. APIs & Services → Credentials → Create API key.',
    '  4. (Recommended) Restrict the key to the Places API.',
    '  5. (Safety) Set a quota cap of 1000/month on Place Details so you can',
    '     never be billed by accident.',
    '  6. Put it in this repo’s .env file:  GOOGLE_MAPS_API_KEY=your_key_here',
    '',
    'Cost & cadence (always free, by hard guarantee):',
    '  • Rich fields bill at the Enterprise+Atmosphere SKU: 1000 free calls/month.',
    '  • Runs DAILY and enriches at most 30/run (PLACES_ENRICH_RUN_LIMIT=30).',
    '  • Pair with a Google Cloud daily quota cap of 30 on "GetPlaceRequest per day".',
    '  • 30/day × 31 days = 930/month < 1000 free → you literally cannot be billed.',
    '  • ~1766 places → fully enriched in ~2 months. A success is never re-enriched.',
    '',
    'Test without spending quota: set PLACES_ENRICH_DRY_RUN=1.',
    'Output: data/out/enriched.json  (+ enrich-usage.json tracks monthly usage).',
  ].join('\n'),
  schedule: '0 3 * * *', // 03:00 every day
  timeoutMs: 0, // budget-capped + each call bounded; no job-level timeout
  maxRetries: 0,
  async run(ctx) {
    await runEnrich(ctx);
  },
};

export default job;
