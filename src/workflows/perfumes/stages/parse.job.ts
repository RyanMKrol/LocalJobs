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
  description:
    'Stage 3 of the perfumes workflow. For each perfume with a captured Fragrantica page from ' +
    'stage 2, asks Claude Code to parse the cached page text into structured notes and accords, ' +
    'written to data/out/fragrantica/<id>.json and gated by the fragrantica-data artifact ' +
    'contract. Each accord\'s percentage (e.g. "woody 83%") is lifted from the page\'s coloured ' +
    'bar CSS width, which is only present when a full <id>.html capture exists from stage 2 — ' +
    'the normal text-only success path leaves that percentage null until the item is re-fetched ' +
    'with an HTML capture. This stage makes no network calls of its own; it only reads the ' +
    'already-cached page and calls Claude Code (routed through the shared claude-cli service).',
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
