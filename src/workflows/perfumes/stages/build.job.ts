import type { JobDefinition } from '../../../core/types.js';
import { fragranticaDataContract } from '../contracts.js';
import { runBuild } from './build.js';
import type { StageResult } from '../types.js';

/** A rate-limited pause with no genuine per-item failures is a soft defer, not a
 *  failure — only a real `failed > 0` tally marks the run failed (T420). */
export function assertNoFailures(result: StageResult): void {
  if (result.failed > 0) {
    throw new Error(`${result.failed}/${result.ok + result.failed} profile(s) failed to build this run — see logs above`);
  }
}

const job: JobDefinition = {
  name: 'perfumes-build',
  description: 'Stage 4: Claude Code combines Fragrantica data + research into a template-compliant profile.',
  timeoutMs: 0,
  maxRetries: 3,
  consumes: [fragranticaDataContract()],
  async run(ctx) {
    const result = await runBuild(ctx);
    assertNoFailures(result);
  },
};

export default job;
