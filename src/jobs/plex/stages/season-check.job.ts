import type { JobDefinition } from '../../../core/types.js';
import { missingSeasonsContract, plexSnapshotContract } from '../contracts.js';
import { runSeasonCheck } from './season-check.js';

const job: JobDefinition = {
  name: 'tmdb-season-check',
  description: 'Stage 2: check TMDB by GUID for complete seasons the owner is missing (ended shows included).',
  timeoutMs: 1_800_000, // ~30 min headroom for a full-library scan (~621 shows)
  maxRetries: 3,
  consumes: [plexSnapshotContract()],
  produces: [missingSeasonsContract()],
  async run(ctx) {
    await runSeasonCheck(ctx);
  },
};

export default job;
