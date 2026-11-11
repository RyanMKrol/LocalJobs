import { makeNotifyStage } from '../../../core/recommender/stages.js';
import { movieArtifacts } from '../contracts.js';
import { ensureDirs } from '../lib.js';
import { moviesDomain } from './branches.js';

export default makeNotifyStage(moviesDomain, movieArtifacts, {
  name: 'movie-recs-notify',
  description: 'Final stage of the movie-recommendations workflow, run once rec-merge succeeds. It reads the recommendations list, leaves out anything the owner has dismissed from the dashboard, rewrites the markdown report (reports/recommendations.md) and sends one push with the films that have not been announced before. Its ledger is a "have I already recommended this?" log rather than a work-done ledger: each announced film is recorded by TMDB id under the job name movie-recs (not this stage\'s own name), so the first run announces the whole current list, every later run announces only what is new, and a dismissed film stays out of every digest until it is un-ignored. Films are marked only after the push succeeds, so a failed push is retried. It also appends every newly announced film to recs-history.json, which the branches and the merge read on later runs so picks vary. (The franchise-gap digest belongs to the missing-movies workflow\'s movie-gaps-notify job.)',
  timeoutMs: 120_000,
  maxRetries: 3,
}, { before: ensureDirs });
