import type { PipelineDefinition } from '../../core/types.js';

/**
 * The places pipeline as a first-class DAG:
 *   ingest → resolve (CID → place_id) → enrich (Places API) → enrich-with-llm (Gemini)
 * Each stage feeds the next via files in data/out + the work_items ledger.
 *
 * Serial (maxConcurrency 1): the resolver uses a headless browser and the last
 * two stages hit PAID APIs (Google Places, Gemini) — they must not overlap, and
 * their per-day/month caps gate progress. Single pass (no repeatUntilStable):
 * a scheduled/manual run processes whatever's ready; capped or transiently-failed
 * items are picked up on the next run (idempotent via the ledger).
 *
 * NOTE: schedule is null (manual) on purpose — the last two stages cost money, so
 * the cadence is a deliberate choice. Set a schedule when ready (the old per-job
 * crons are suppressed now that these jobs are pipeline members).
 */
const pipeline: PipelineDefinition = {
  name: 'places',
  description: 'Ingest Takeout → resolve CID→place_id → enrich (Places API) → enrich with LLM (Gemini).',
  schedule: null,
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
