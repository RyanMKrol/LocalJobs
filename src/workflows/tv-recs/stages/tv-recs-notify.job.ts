import { makeNotifyStage } from '../../../core/recommender/stages.js';
import { tvArtifacts } from '../contracts.js';
import { ensureDirs } from '../lib.js';
import { tvDomain } from './branches.js';

export default makeNotifyStage(tvDomain, tvArtifacts, {
  name: 'tv-recs-notify',
  description: 'Final stage of the tv-recommendations workflow, reading tv-rec-merge\'s verified ' +
    'recommendation list. It leaves out any show the owner has dismissed from the dashboard and treats any ' +
    'show already recorded in the tv-recs ledger (keyed by TMDB id, under the job name tv-recs rather than ' +
    'this stage\'s own name) as already announced, so each recommended show is announced exactly once ' +
    'however many monthly runs it keeps appearing in. On every run it rewrites the markdown report at ' +
    'data/out/reports/tv-recommendations.md with all current recommendations. If any are new it sends one ' +
    'digest push, and only after the push succeeds records each announced show in the ledger and appends it ' +
    'to the recommendation-history file, which the branches and the merge read on later runs to steer away ' +
    'from repeats. A failed push fails the run before anything is recorded, so it is retried.',
  timeoutMs: 120_000,
  maxRetries: 3,
}, { before: ensureDirs });
