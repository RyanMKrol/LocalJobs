import { makeMergeStage } from '../../../core/recommender/stages.js';
import { tvArtifacts } from '../contracts.js';
import { ensureDirs } from '../lib.js';
import { tvDomain } from './branches.js';

// The fan-in. Its `branches` input is fed by every one of the 8 branch stages
// (one entry per branch), and it starts only when all of them have succeeded. It
// also reads the snapshot and the taste profile directly, which is why the
// manifest gives it an edge from tv-snapshot as well.
export default makeMergeStage(tvDomain, tvArtifacts, {
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
}, { before: ensureDirs });
