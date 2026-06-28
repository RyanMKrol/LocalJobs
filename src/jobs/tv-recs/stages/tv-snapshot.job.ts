import type { JobDefinition } from '../../../core/types.js';
import { tvSnapshotContract } from '../contracts.js';
import { runTvSnapshot } from './tv-snapshot.js';

const job: JobDefinition = {
  name: 'tv-snapshot',
  description: 'Stage 1: snapshot the Plex TV library by GUID — each show, its TMDB id, and taste metadata (genres/roles/decades/countries).',
  timeoutMs: 300_000,
  maxRetries: 3,
  produces: [tvSnapshotContract()],
  async run(ctx) {
    await runTvSnapshot(ctx);
  },
};

export default job;
