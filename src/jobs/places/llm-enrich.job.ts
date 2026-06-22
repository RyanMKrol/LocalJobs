import type { JobDefinition } from '../../core/types.js';
import { enrichedPlacesContract } from './contracts.js';
import { runLlmEnrich } from './llm-enrich.js';

/**
 * LLM enrichment: research each enriched place with Gemini (Google Search
 * grounding + website fetch) and write a second-brain profile + markdown.
 * Idempotent by place_id via the work_items ledger — never reprocesses a
 * place that's already done.
 */
const job: JobDefinition = {
  name: 'enrich-with-llm',
  description: 'Research each place with Gemini (grounded search + website) into a second-brain profile.',
  timeoutMs: 0,
  maxRetries: 3,
  consumes: [enrichedPlacesContract()],
  async run(ctx) {
    await runLlmEnrich(ctx);
  },
};

export default job;
