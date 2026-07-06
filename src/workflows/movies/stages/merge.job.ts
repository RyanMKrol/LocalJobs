import type { JobDefinition } from '../../../core/types.js';
import { branchSuggestionsContract, recommendationsContract } from '../contracts.js';
import { BRANCHES } from './branches.js';
import { runMerge } from './merge.js';

const job: JobDefinition = {
  name: 'rec-merge',
  description: 'Fan-in stage that pools the raw suggestions written by all 8 recommender branches (rec-random-1/2/3, rec-auteur, rec-canon, rec-thin-genre, rec-older-era, rec-world-cinema) once every one of them completes, then subjects each suggested title to a code-side verification pipeline: a TMDB title search to confirm the film is real (an unmatched title is treated as a model hallucination and dropped), an owned-library check, an already-recommended-or-ignored check against the recs work-item ledger so nothing resurfaces once seen, and a quality bar on TMDB rating and vote count. Survivors are deduped across branches by title and year (merging lens tags when multiple branches independently suggest the same film) and capped per genre so no single genre dominates the final list. If fewer than the target number of picks survive this first pass, it runs a bounded top-up loop that re-prompts the branches in-memory for more suggestions — excluding everything already collected, owned, or considered so far this run — re-verifies and re-merges, repeating until the target is met or the round budget is exhausted. Writes recommendations.json (the final balanced list movie-gaps-notify reads) and appends every newly-recommended title to recs-history.json so future runs\' branch prompts know to avoid repeating them.',
  timeoutMs: 1_800_000, // ~30 min headroom for TMDB title searches
  maxRetries: 2,
  // Consume EVERY branch's raw-suggestions hand-off (one gate per branch→rec-merge edge).
  consumes: BRANCHES.map((b) => branchSuggestionsContract(b.id)),
  produces: [recommendationsContract()],
  async run(ctx) {
    await runMerge(ctx);
  },
};

export default job;
