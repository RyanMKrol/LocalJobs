import type { JobDefinition } from '../../../core/types.js';
import { fragranticaPagesContract, fragranticaUrlsContract } from '../contracts.js';
import { runFetch } from './fetch.js';
import type { StageResult } from '../types.js';

/** A rate-limited pause with no genuine per-item failures is a soft defer, not a
 *  failure — only a real `failed > 0` tally marks the run failed (T420). */
export function assertNoFailures(result: StageResult): void {
  if (result.failed > 0) {
    throw new Error(`${result.failed}/${result.ok + result.failed} page(s) failed to fetch this run — see logs above`);
  }
}

const job: JobDefinition = {
  name: 'perfumes-fetch',
  description: 'Stage 2: headless browser captures each Fragrantica page\'s full text (scrolled).',
  timeoutMs: 0,
  maxRetries: 3,
  consumes: [fragranticaUrlsContract()],
  produces: [fragranticaPagesContract()],
  async run(ctx) {
    const result = await runFetch(ctx);
    assertNoFailures(result);
  },
};

export default job;
