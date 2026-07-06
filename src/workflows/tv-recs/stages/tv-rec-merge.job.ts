import type { JobDefinition } from '../../../core/types.js';
import { tvBranchSuggestionsContract, tvRecommendationsContract } from '../contracts.js';
import { BRANCHES } from './branches.js';
import { runTvRecMerge } from './tv-rec-merge.js';

const job: JobDefinition = {
  name: 'tv-rec-merge',
  description: 'Merge stage of the tv-recommendations workflow, depending on all 8 recommender branches. ' +
    'It pools every branch\'s raw suggestions and TMDB-verifies each one via the shared plex-client (a real ' +
    'show, not already owned, not previously recommended), dedupes across branches, and enforces a quality ' +
    'bar (minimum TMDB rating and vote count) so only well-regarded picks survive. It balances the ' +
    'surviving list by capping how many picks come from any one genre, then tops it up with a bounded ' +
    'round-based re-prompt loop — re-asking a subset of branches with recent and historical recommendation ' +
    'titles fed back in as exclusions — until it reaches the target recommendation count or exhausts its ' +
    'retry rounds. Writes data/out/recommendations.json, the final verified list that tv-recs-notify reads ' +
    'to build the monthly digest.',
  timeoutMs: 1_800_000,
  maxRetries: 2,
  consumes: BRANCHES.map((b) => tvBranchSuggestionsContract(b.id)),
  produces: [tvRecommendationsContract()],
  async run(ctx) {
    await runTvRecMerge(ctx);
  },
};

export default job;
