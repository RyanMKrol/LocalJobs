import type { JobDefinition } from '../../../core/types.js';
import { plexSnapshotContract } from '../contracts.js';
import { runSnapshot } from './snapshot.js';

const job: JobDefinition = {
  name: 'plex-tv-snapshot',
  description: 'Stage 1: snapshot the Plex TV library by GUID — each show + its highest owned regular season.',
  timeoutMs: 300_000,
  maxRetries: 3,
  produces: [plexSnapshotContract()],
  async run(ctx) {
    await runSnapshot(ctx);
  },
};

export default job;
