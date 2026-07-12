import type { JobDefinition } from '../../../core/types.js';
import { missingMoviesSnapshotContract } from '../contracts.js';
import { runSnapshot } from './snapshot.js';

const job: JobDefinition = {
  name: 'plex-movie-snapshot',
  description: 'First stage of the weekly missing-movies franchise-gap audit. Reads the owner\'s Plex movie library section (PLEX_MOVIE_SECTION) via the shared Plex client, matching each movie to its TMDB id from the tmdb:// GUID Plex records — a movie with no such GUID is flagged and excluded from downstream franchise-gap checking. Writes snapshot.json (every owned movie plus its TMDB id, used as the owned-set for franchise-gap detection). This is a DEDICATED snapshot for this workflow, deliberately duplicated from movie-recommendations\'s own movie-snapshot stage rather than shared, so the two workflows run on fully independent schedules; unlike that stage it does not build a taste profile, since nothing downstream here consumes one. This stage recomputes fresh every run rather than skipping already-seen movies, since the Plex library itself can change week to week.',
  timeoutMs: 300_000,
  maxRetries: 3,
  produces: [missingMoviesSnapshotContract()],
  async run(ctx) {
    await runSnapshot(ctx);
  },
};

export default job;
