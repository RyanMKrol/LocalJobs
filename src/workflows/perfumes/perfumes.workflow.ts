import type { WorkflowDefinition } from '../../core/types.js';
import { perfumesConfig } from './config.js';

/**
 * The perfumes workflow:
 *   find-url → fetch → parse → build      (build also takes the URLs from find-url)
 * Serial (maxConcurrency 1) because the stages share one Chrome profile and the
 * Claude CLI. repeatUntilStable runs the four stages again in cycles until no
 * retryable perfume is left or a cycle makes no progress, up to maxCycles.
 * Each stage adds to a store that grows across runs (see contracts.ts).
 */
const workflow: WorkflowDefinition = {
  name: 'perfumes',
  category: 'second-brain',
  description: 'Builds a rich markdown profile for each perfume in your collection. Starting from the perfumes you have rated on your website (the PerfumeRatings table), it finds each one\'s Fragrantica page, fetches it with a headless real-Chrome browser (to pass Cloudflare clearance), has Claude parse the saved page into structured notes, accords and community votes, then researches and writes the final profile using the Claude CLI. It repeats the four stages until no retryable items remain.',
  idempotencyNote: 'Each perfume in your collection is tracked individually through find-URL, fetch, parse, and profile-build — once a stage succeeds for a perfume it\'s never redone, so re-runs only advance perfumes that are new or still incomplete.',
  schedule: '0 2 * * *',
  maxConcurrency: 1,
  repeatUntilStable: true,
  maxCycles: perfumesConfig.maxCycles,
  cycleSleepMs: perfumesConfig.cycleSleepMs,
  minAttempts: perfumesConfig.maxAttempts,
  jobs: [
    { job: 'perfumes-find-url' },
    { job: 'perfumes-fetch', dependsOn: ['perfumes-find-url'] },
    { job: 'perfumes-parse', dependsOn: ['perfumes-fetch'] },
    // The build is handed the parsed data by parse and the URL store by find-url
    // (it cites each perfume's Fragrantica page), so it depends on both.
    { job: 'perfumes-build', dependsOn: ['perfumes-find-url', 'perfumes-parse'] },
  ],
};

export default workflow;
