import type { JobDefinition } from '../../../core/types.js';
import { missingMoviesSnapshotContract } from '../contracts.js';
import { runSnapshot } from './snapshot.js';

const job: JobDefinition = {
  name: 'plex-movie-snapshot',
  description: 'First stage of the weekly missing-movies franchise-gap audit — this workflow\'s OWN Plex movie snapshot, separate from movie-recommendations\'s movie-snapshot (mirrors plex-tv-snapshot vs the TV recommender\'s snapshot). Reads the owner\'s Plex movie library section (PLEX_MOVIE_SECTION) via the shared Plex client, matching each movie to its TMDB id from the tmdb:// GUID Plex records — a movie with no such GUID is flagged and excluded from downstream franchise-gap checking. Writes only snapshot.json (every owned movie plus its TMDB id); unlike movie-recommendations\'s snapshot it does NOT build a taste-profile.json, since franchise-gaps (the only consumer here) never reads one. This stage recomputes fresh every run rather than skipping already-seen movies, since the Plex library itself can change week to week.',
  timeoutMs: 300_000,
  maxRetries: 3,
  produces: [missingMoviesSnapshotContract()],
  async run(ctx) {
    await runSnapshot(ctx);
  },
};

export default job;
