import type { PipelineDefinition } from '../../core/types.js';

/**
 * The places pipeline as a first-class DAG:
 *   ingest → resolve (CID → place_id) → enrich (Places API) → enrich-with-llm (Gemini)
 * Each stage feeds the next via files in data/out + the work_items ledger.
 *
 * Serial (maxConcurrency 1): the resolver uses a headless browser and the last
 * two stages hit PAID APIs (Google Places, Gemini) — they must not overlap, and
 * their per-day/month caps gate progress. Single pass (no repeatUntilStable):
 * a scheduled run processes whatever's ready; capped or transiently-failed
 * items are picked up on the next run (idempotent via the ledger).
 *
 * Runs DAILY at 03:00 (the old per-job crons are suppressed now that these jobs
 * are pipeline members). The cost of the paid stages is bounded by the per-stage
 * daily spend cap (= monthly free allowance / 30, see config.ts DAILY_SPEND_DIVISOR),
 * so a daily run drains the backlog steadily and can never blow the month.
 */
const pipeline: PipelineDefinition = {
  name: 'places',
  description: 'Ingest Takeout → resolve CID→place_id → enrich (Places API) → enrich with LLM (Gemini).',
  schedule: '0 3 * * *',
  maxConcurrency: 1,
  repeatUntilStable: false,
  jobs: [
    { job: 'places-ingest' },
    { job: 'cid-to-place-id-resolver', dependsOn: ['places-ingest'] },
    { job: 'places-enrich', dependsOn: ['cid-to-place-id-resolver'] },
    { job: 'enrich-with-llm', dependsOn: ['places-enrich'] },
  ],
};

export default pipeline;
