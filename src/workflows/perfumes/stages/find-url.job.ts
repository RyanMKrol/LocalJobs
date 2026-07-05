import type { JobDefinition } from '../../../core/types.js';
import { fragranticaUrlsContract } from '../contracts.js';
import { runFindUrl } from './find-url.js';
import { loadPerfumes } from '../lib.js';
import type { StageResult } from '../types.js';

/** A rate-limited pause with no genuine per-item failures is a soft defer, not a
 *  failure — only a real `failed > 0` tally marks the run failed (T420). */
export function assertNoFailures(result: StageResult): void {
  if (result.failed > 0) {
    throw new Error(`${result.failed}/${result.ok + result.failed} perfume(s) failed to find a Fragrantica URL this run — see logs above`);
  }
}

const job: JobDefinition = {
  name: 'perfumes-find-url',
  description: 'Stage 1: find each perfume\'s Fragrantica URL via Claude Code (web search).',
  timeoutMs: 0,
  maxRetries: 3,
  produces: [fragranticaUrlsContract()],
  // Root stage (T094): each perfume id is an originating input. A manual run-limit
  // selects the first N of these; the same id keys every downstream stage (1:1),
  // so root_key propagates for free (markWorkItem rule 3). Guarded so a transient
  // DynamoDB read failure never breaks run-start selection in the daemon.
  async inputKeys() {
    try { return (await loadPerfumes()).map((p) => p.id); } catch { return []; }
  },
  async run(ctx) {
    const result = await runFindUrl(ctx);
    assertNoFailures(result);
  },
};

export default job;
