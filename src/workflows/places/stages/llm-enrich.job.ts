import { mkdirSync } from 'node:fs';
import { defineStage } from '../../../engine/index.js';
import { placesConfig } from '../config.js';
import { enrichedPlaces, normalizedPlaces, placeProfiles } from '../contracts.js';
import { runLlmEnrich } from './llm-enrich.js';

/**
 * LLM enrichment: research each enriched place with Gemini (Google Search
 * grounding + website fetch) and write a second-brain profile + markdown.
 * Idempotent by place_id via the work_items ledger — never reprocesses a
 * place that's already done.
 */
export default defineStage({
  name: 'enrich-with-llm',
  description:
    'The final stage of the places workflow. It reads data/out/enriched.json (written by places-enrich) and, for each not-' +
    'yet-processed place, asks Gemini (default model gemini-flash-lite-latest, with Google Search grounding and website ' +
    'fetching enabled) to write a researched prose summary, blending the Places API details with the CSV notes the owner ' +
    'originally saved with the place. It writes the combined result to data/out/llm-enriched.json and one markdown ' +
    'second-brain profile per place under data/out/markdown/<slug>.md (frontmatter plus body). Idempotent by place_id via ' +
    'the work_items ledger, so a place already processed is never reprocessed; spend is governed solely by the shared ' +
    'gemini service quota, which soft-fails gracefully when exhausted rather than throwing. Requires GEMINI_API_KEY. Since ' +
    'this stage re-keys by place_id, it explicitly records the originating CID as rootKey so manual run-limits and lineage ' +
    'tracking stay correct back to the first stage.',
  timeoutMs: 0,
  maxRetries: 3,
  // Two inputs from two stages: the Places details, and the normalized places
  // (for each place's lists and the owner's notes), which is why the manifest
  // gives this stage an edge from places-ingest as well.
  inputs: {
    enriched: { artifact: enrichedPlaces },
    places: { artifact: normalizedPlaces },
  },
  // One profile per place, added to as places are decorated.
  outputs: {
    profiles: { artifact: placeProfiles, location: () => placesConfig.markdownDir, cumulative: true },
  },
  // The profiles are what this workflow is for.
  product: true,
  async run(ctx) {
    // The folder exists from the first run on, even before any place is decorated.
    mkdirSync(placesConfig.markdownDir, { recursive: true });
    await runLlmEnrich(ctx);
  },
});
