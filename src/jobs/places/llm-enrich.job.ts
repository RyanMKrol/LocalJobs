import type { JobDefinition } from '../../core/types.js';
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
  instructions: [
    'Prerequisite: run "places-enrich" first so data/out/enriched.json exists.',
    '',
    'One-time setup — get a Gemini API key:',
    '  1. aistudio.google.com → "Get API key" → create a key.',
    '  2. (Privacy) Enable billing on the Google Cloud project so your data is',
    '     NOT used to train Google models — you still stay within the free',
    '     grounding quota (5,000 grounded prompts/month on Gemini 3.x), so $0.',
    '  3. Put it in .env:  GEMINI_API_KEY=your_key_here',
    '  4. (Optional) pin a model:  GEMINI_MODEL=gemini-flash-latest',
    '',
    'How it works: per place it uses Google Search grounding + fetches the',
    'place\'s own website, then writes a structured profile (type, cuisine, vibe,',
    'must-book, etc.) — geared for "where should I go?" questions.',
    '',
    'Idempotent by place_id: each place\'s outcome is recorded in the work_items',
    'table; re-runs skip places already done. Safe to run repeatedly.',
    '',
    'Test without a key / quota: PLACES_LLM_DRY_RUN=1.  Cap a run: PLACES_LLM_RUN_LIMIT=5.',
    'Output: data/out/llm-enriched.json + data/out/markdown/<place>.md',
  ].join('\n'),
  schedule: '0 5 * * *', // 05:00 daily — after resolve (Sun 04:00) and enrich (03:00)
  timeoutMs: 0,
  maxRetries: 0,
  async run(ctx) {
    await runLlmEnrich(ctx);
  },
};

export default job;
