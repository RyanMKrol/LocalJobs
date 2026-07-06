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
  description:
    'Stage 4 (final) of the perfumes workflow. For each perfume with parsed Fragrantica data from ' +
    'stage 3, asks Claude Code to research the perfume further on the web and write a complete ' +
    'markdown profile that follows the enforced profile.template.md contract (YAML frontmatter ' +
    'covering name, brand, notes pyramid, accords, wear profile, community rating and ' +
    'provenance, plus fixed narrative sections). It blends Fragrantica\'s community vote signal ' +
    'against the LLM\'s own research using a continuous confidence weight based on the perfume\'s ' +
    'vote count relative to the scraped corpus\'s median, passing that weight into the prompt as ' +
    'an explicit instruction to state the confidence level in the written profile (there is no ' +
    'separate validator that checks the prose actually honors it). The finished profile is ' +
    'written to data/out/markdown/<id>.md.',
  timeoutMs: 0,
  maxRetries: 3,
  consumes: [fragranticaDataContract()],
  async run(ctx) {
    const result = await runBuild(ctx);
    assertNoFailures(result);
  },
};

export default job;
