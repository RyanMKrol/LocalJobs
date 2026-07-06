import type { JobDefinition } from '../../../core/types.js';
import { movieSnapshotContract } from '../contracts.js';
import { runSnapshot } from './snapshot.js';

const job: JobDefinition = {
  name: 'movie-snapshot',
  description: 'First stage of the monthly movie-recommendations audit. Reads the owner\'s Plex movie library section (PLEX_MOVIE_SECTION) via the shared Plex client, matching each movie to its TMDB id from the tmdb:// GUID Plex records — a movie with no such GUID is flagged and excluded from downstream franchise-gap checking, but still counted for taste purposes. Writes two files the rest of the DAG depends on: snapshot.json (every owned movie plus its TMDB id, used as the owned-set for franchise-gap and recommendation dedup) and taste-profile.json (aggregated genre/director/decade/country counts derived from the owned library, which the 8 recommender branches use to target their prompts). This stage recomputes fresh every run rather than skipping already-seen movies, since the Plex library itself can change month to month.',
  timeoutMs: 300_000,
  maxRetries: 3,
  produces: [movieSnapshotContract()],
  async run(ctx) {
    await runSnapshot(ctx);
  },
};

export default job;
