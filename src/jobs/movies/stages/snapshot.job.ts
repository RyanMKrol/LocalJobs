import type { JobDefinition } from '../../../core/types.js';
import { movieSnapshotContract } from '../contracts.js';
import { runSnapshot } from './snapshot.js';

const job: JobDefinition = {
  name: 'movie-snapshot',
  description: 'Stage 1: snapshot the Plex movie library by GUID — each movie, its TMDB id, and taste metadata (genres/directors/decades/countries).',
  timeoutMs: 300_000,
  maxRetries: 3,
  produces: [movieSnapshotContract()],
  async run(ctx) {
    await runSnapshot(ctx);
  },
};

export default job;
