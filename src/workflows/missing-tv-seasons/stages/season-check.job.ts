import type { JobDefinition } from '../../../core/types.js';
import { missingSeasonsContract, plexSnapshotContract } from '../contracts.js';
import { runSeasonCheck } from './season-check.js';

const job: JobDefinition = {
  name: 'tmdb-season-check',
  description: 'Stage 2 of the weekly missing-TV-seasons audit. Reads the Plex snapshot from stage 1 and, for every show with a resolved TMDB id, calls TMDB through the shared rate-limited tmdb service to find the highest season that has actually aired and to check, season by season above what is currently owned, whether every episode in that season has aired (a genuinely complete season, not just a season that has started). Shows marked ended or canceled on TMDB are still checked, not skipped, since a cancelled show can be revived with new seasons later. Like stage 1, this stage recomputes fresh from Plex + TMDB on every run rather than skipping already-checked shows, because idempotency for this workflow is deliberately deferred to the final notify stage. The full set of newly-missing (show, season) pairs is written to data/out/missing-seasons.json for stage 3 to digest.',
  timeoutMs: 1_800_000, // ~30 min headroom for a full-library scan (~621 shows)
  maxRetries: 3,
  consumes: [plexSnapshotContract()],
  produces: [missingSeasonsContract()],
  async run(ctx) {
    await runSeasonCheck(ctx);
  },
};

export default job;
