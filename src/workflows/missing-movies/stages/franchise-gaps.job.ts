import type { JobDefinition } from '../../../core/types.js';
import { franchiseGapsContract, missingMoviesSnapshotContract } from '../contracts.js';
import { runFranchiseGaps } from './franchise-gaps.js';

const job: JobDefinition = {
  name: 'franchise-gaps',
  description: 'Deterministic franchise-gap audit for the weekly missing-movies workflow (T468 — split out of movie-recommendations; the job name is UNCHANGED from before the split, so its existing work_items ledger rows keep resolving with zero migration). For every owned movie with a TMDB id it fetches the movie\'s belongs_to_collection via TMDB, deduping down to the distinct set of collections the library actually touches, then fetches each collection\'s full parts list and flags any RELEASED part the owner does not already own as a gap — there is no quality/rating filter here, since a franchise gap is a factual fact about ownership rather than a taste judgment. Every TMDB call routes through the shared tmdb service so the global rate limit and monthly quota are respected; hitting the quota mid-pass stops gracefully and writes whatever gaps were found so far rather than failing the run. Writes franchise-gaps.json sorted by collection, year, and title, including one example owned title per collection so the eventual digest can show "you already own: X" context alongside each gap.',
  timeoutMs: 1_800_000, // ~30 min headroom: ~1,500 /movie calls + collection fetches
  maxRetries: 3,
  consumes: [missingMoviesSnapshotContract()],
  produces: [franchiseGapsContract()],
  async run(ctx) {
    await runFranchiseGaps(ctx);
  },
};

export default job;
