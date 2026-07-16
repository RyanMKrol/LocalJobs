import type { WorkflowDefinition } from '../../core/types.js';
import { perfumesConfig } from './config.js';

/**
 * The perfumes workflow as a first-class DAG the framework executes:
 *   find-url → fetch → parse → build
 * Replaces the old hand-written orchestrator loop (workflow.job.ts). Serial
 * (maxConcurrency 1) because the stages share one Chrome profile + the Claude CLI;
 * repeatUntilStable reproduces the old "loop until no retryable work" behaviour.
 * Each stage stays runnable on its own (perfumes-find-url / -fetch / -parse / -build).
 */
const workflow: WorkflowDefinition = {
  name: 'perfumes',
  category: 'second-brain',
  description: 'Builds a rich markdown profile for each perfume in your collection. Starting from a list of fragrance names, it discovers each one\'s Fragrantica page, fetches it via a headless real-Chrome browser (to pass Cloudflare clearance), parses out structured notes and accords from the saved HTML, then researches and writes the final profile using the Claude CLI — cycling until no retryable items remain.',
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
    { job: 'perfumes-build', dependsOn: ['perfumes-parse'] },
  ],
};

export default workflow;
