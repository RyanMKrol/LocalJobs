import type { JobDefinition } from '../../../core/types.js';
import { fragranticaDataContract, fragranticaPagesContract } from '../contracts.js';
import { runParse } from './parse.js';
import type { StageResult } from '../types.js';

/** A rate-limited pause with no genuine per-item failures is a soft defer, not a
 *  failure — only a real `failed > 0` tally marks the run failed (T420). */
export function assertNoFailures(result: StageResult): void {
  if (result.failed > 0) {
    throw new Error(`${result.failed}/${result.ok + result.failed} page(s) failed to parse this run — see logs above`);
  }
}

const job: JobDefinition = {
  name: 'perfumes-parse',
  description: 'Stage 3: Claude Code parses each captured page into structured Fragrantica JSON.',
  timeoutMs: 0,
  maxRetries: 3,
  consumes: [fragranticaPagesContract()],
  produces: [fragranticaDataContract()],
  async run(ctx) {
    const result = await runParse(ctx);
    assertNoFailures(result);
  },
};

export default job;
