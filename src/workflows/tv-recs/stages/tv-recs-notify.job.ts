import { makeNotifyStage } from '../../../core/recommender/stages.js';
import { tvArtifacts } from '../contracts.js';
import { ensureDirs } from '../lib.js';
import { tvDomain } from './branches.js';

export default makeNotifyStage(tvDomain, tvArtifacts, {
  name: 'tv-recs-notify',
  description: 'Terminal stage of the tv-recommendations workflow, consuming tv-rec-merge\'s verified ' +
    'recommendation list. It filters out any show the owner has permanently ignored via the dashboard and ' +
    'any show already recorded in the tv-recs notification ledger (keyed by TMDB id), so each recommended ' +
    'show is announced exactly once regardless of how many monthly runs it keeps surfacing across. For the ' +
    'remaining newly-verified picks it writes a markdown digest to data/out/reports/tv-recommendations.md, ' +
    'sends the run\'s single aggregate notification, records each notified show in the ledger, and appends ' +
    'them to the shared recommendation-history file that tv-rec-merge reads back on future runs to steer ' +
    'its branches away from repeats.',
  timeoutMs: 120_000,
  maxRetries: 3,
}, { before: ensureDirs });
