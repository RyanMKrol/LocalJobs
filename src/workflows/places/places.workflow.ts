import type { WorkflowDefinition } from '../../core/types.js';

/**
 * The places workflow:
 *   ingest → resolve (CID → place_id) → enrich (Places API) → enrich-with-llm (Gemini)
 * Each stage declares the file it hands to the next (see contracts.ts) and keeps
 * a per-place ledger, which is what makes the pipeline incremental. The last
 * stage also takes the normalized places from ingest.
 *
 * Serial (maxConcurrency 1): the resolver uses a headless browser and the last
 * two stages hit PAID APIs (Google Places, Gemini) — they must not overlap, and
 * their per-day/month caps gate progress. Single pass (no repeatUntilStable):
 * a scheduled run processes whatever's ready; capped or transiently-failed
 * items are picked up on the next run (idempotent via the ledger).
 *
 * Runs DAILY at 03:00. The cost of the paid stages is bounded by each paid
 * service's daily cap (monthly allowance / 30, see DAILY_SPEND_DIVISOR in
 * src/services/lib.ts), so a daily run drains the backlog steadily and can
 * never blow the month.
 */
const workflow: WorkflowDefinition = {
  name: 'places',
  category: 'second-brain',
  description: 'Enriches your Google saved places with structured data and prose summaries. It ingests saved-place CSVs exported from Google Takeout, resolves each venue\'s opaque CID to a canonical place_id via a headless browser, fetches full details from the Google Places API, then generates a Gemini-written summary and writes a formatted markdown profile — running daily with spend governed by per-day service quotas so it steadily drains the backlog without blowing the monthly cap.',
  idempotencyNote: 'Each saved place is tracked individually and skipped once fully enriched — a place already resolved, looked up, and summarized is never redone, so re-runs only pick up new or previously-failed places.',
  schedule: '0 3 * * *',
  maxConcurrency: 1,
  repeatUntilStable: false,
  jobs: [
    { job: 'places-ingest' },
    { job: 'cid-to-place-id-resolver', dependsOn: ['places-ingest'] },
    { job: 'places-enrich', dependsOn: ['cid-to-place-id-resolver'] },
    // The last stage also reads the normalized places (each place's lists and the
    // owner's notes), so it depends on the ingest stage directly as well.
    { job: 'enrich-with-llm', dependsOn: ['places-ingest', 'places-enrich'] },
  ],
};

export default workflow;
