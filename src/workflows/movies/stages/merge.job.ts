import { makeMergeStage } from '../../../core/recommender/stages.js';
import { movieArtifacts } from '../contracts.js';
import { ensureDirs } from '../lib.js';
import { moviesDomain } from './branches.js';

// The fan-in. Its `branches` input is fed by every one of the 8 branch stages
// (one entry per branch), and it starts only when all of them have succeeded. It
// also reads the snapshot and the taste profile directly, which is why the
// manifest gives it an edge from movie-snapshot as well.
export default makeMergeStage(moviesDomain, movieArtifacts, {
  name: 'rec-merge',
  description: 'Fan-in stage. Once all 8 recommender branches (rec-random-1/2/3, rec-auteur, rec-canon, rec-thin-genre, rec-older-era, rec-world-cinema) have succeeded it pools the suggestions each one committed in this run, drops duplicates by title and year, and puts every remaining title through checks done in code: a TMDB title search to confirm the film is real (a title with no match is treated as made up by the model and dropped), a check against the owned library from the snapshot, a check against the movie-recs ledger so nothing already recommended or dismissed comes back, and a quality bar on TMDB rating and vote count. Suggestions that resolve to the same TMDB id are merged, joining their lens tags, and the list is capped per genre so no single genre dominates. If fewer than the target number of picks survive, it runs a bounded top-up loop that re-prompts the branches in memory for more suggestions, excluding everything already considered this run, then verifies and balances again, until the target is met, a round brings nothing new, or the rounds run out. Writes recommendations.json, the list movie-recs-notify reads. If any TMDB search errored it still writes the list and then fails the run so it is retried.',
  timeoutMs: 1_800_000, // ~30 min headroom for TMDB title searches
  maxRetries: 2,
}, { before: ensureDirs });
