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
    'fetching enabled) to write a researched prose summary from the Places API details. It saves the verdict to ' +
    'data/out/llm-enriched.json and writes one markdown second-brain profile per place under data/out/markdown/<slug>.md ' +
    '(frontmatter plus body). The lists the owner saved the place to and the notes saved with it come from ' +
    'data/out/places.json and go into the markdown only, never into the prompt. Idempotent by place_id via the ' +
    'work_items ledger, so a place already processed is never reprocessed. Spend is governed solely by the shared gemini ' +
    'service quota: a reached quota or a rate limit stops the run gracefully, while depleted credits or a revoked key ' +
    'fail the run, since no later run would get past them. Requires GEMINI_API_KEY. Since ' +
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
