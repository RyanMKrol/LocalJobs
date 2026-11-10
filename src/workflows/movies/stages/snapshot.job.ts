import { defineStage } from '../../../engine/index.js';
import { moviesConfig } from '../config.js';
import { movieArtifacts } from '../contracts.js';
import { runSnapshot } from './snapshot.js';

export default defineStage({
  name: 'movie-snapshot',
  description: 'First stage of the monthly movie-recommendations audit. Reads the owner\'s Plex movie library section (PLEX_MOVIE_SECTION) via the shared Plex client, matching each movie to its TMDB id from the tmdb:// GUID Plex records — a movie with no such GUID is flagged and excluded from downstream franchise-gap checking, but still counted for taste purposes. Writes two files the rest of the DAG depends on: snapshot.json (every owned movie plus its TMDB id, used as the owned-set for franchise-gap and recommendation dedup) and taste-profile.json (aggregated genre/director/decade/country counts derived from the owned library, which the 8 recommender branches use to target their prompts). This stage recomputes fresh every run rather than skipping already-seen movies, since the Plex library itself can change month to month.',
  timeoutMs: 300_000,
  maxRetries: 3,
  // Both files are rebuilt from Plex on every run, and both must be: a run that
  // returned without writing either fails here rather than handing the branches
  // last month's library.
  outputs: {
    snapshot: { artifact: movieArtifacts.snapshot, location: () => moviesConfig.snapshotOut },
    taste: { artifact: movieArtifacts.taste, location: () => moviesConfig.tasteOut },
  },
  async run(ctx) {
    await runSnapshot(ctx);
  },
});
