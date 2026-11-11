import { defineStage } from '../../../engine/index.js';
import { moviesConfig } from '../config.js';
import { movieArtifacts } from '../contracts.js';
import { runSnapshot } from './snapshot.js';

export default defineStage({
  name: 'movie-snapshot',
  description: 'First stage of the monthly movie-recommendations workflow. Reads the owner\'s Plex movie library section (PLEX_MOVIE_SECTION) via the shared Plex client, taking each movie\'s TMDB id from the tmdb:// GUID Plex records and never guessing one. A movie with no such GUID is logged and keeps no id, so it cannot be matched against a recommendation, but it still counts towards the taste profile. Writes two files the rest of the DAG reads: snapshot.json (every owned movie with its TMDB id and taste metadata, which the merge uses to drop films already owned) and taste-profile.json (genre, director, decade and country counts across the library, which the 8 recommender branches use to target their prompts). This stage recomputes fresh every run rather than skipping already-seen movies, since the Plex library itself can change month to month. It writes no ledger rows.',
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
