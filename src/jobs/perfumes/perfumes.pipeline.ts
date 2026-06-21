import type { PipelineDefinition } from '../../core/types.js';
import { perfumesConfig } from './config.js';

/**
 * The perfumes pipeline as a first-class DAG the framework executes:
 *   find-url → fetch → parse → build
 * Replaces the old hand-written orchestrator loop (pipeline.job.ts). Serial
 * (maxConcurrency 1) because the stages share one Chrome profile + the Claude CLI;
 * repeatUntilStable reproduces the old "loop until no retryable work" behaviour.
 * Each stage stays runnable on its own (perfumes-find-url / -fetch / -parse / -build).
 */
const pipeline: PipelineDefinition = {
  name: 'perfumes',
  description: 'Find Fragrantica URL → headless fetch → parse → research + write markdown.',
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

export default pipeline;
