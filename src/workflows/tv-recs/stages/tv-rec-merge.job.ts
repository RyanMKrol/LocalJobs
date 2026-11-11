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
  description: 'Merge stage of the tv-recommendations workflow. It depends on all 8 recommender branches ' +
    'and on tv-snapshot, and starts only when every one of them has succeeded. It pools the suggestions each ' +
    'branch committed in this run, drops duplicates by title and year, and checks each remaining title in ' +
    'code: a TMDB search through the shared plex-client to confirm it is a real show, a check against the ' +
    'owned library from the snapshot, a check against the tv-recs ledger so nothing already recommended or ' +
    'dismissed comes back, and a quality bar (minimum TMDB rating and vote count). Suggestions that resolve ' +
    'to the same TMDB id are merged, and the list is balanced by capping how many picks come from any one ' +
    'genre. If it is short of the target it runs a bounded top-up loop that re-asks all the branches in ' +
    'memory, with every title already considered fed back as an exclusion, until it reaches the target, a ' +
    'round brings nothing new, or the rounds run out. Writes data/out/recommendations.json, the verified ' +
    'list tv-recs-notify reads. If any TMDB search errored it still writes the list and then fails the run ' +
    'so it is retried.',
  timeoutMs: 1_800_000,
  maxRetries: 2,
}, { before: ensureDirs });
