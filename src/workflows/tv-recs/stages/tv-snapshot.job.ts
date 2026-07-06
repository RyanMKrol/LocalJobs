import type { JobDefinition } from '../../../core/types.js';
import { tvSnapshotContract } from '../contracts.js';
import { runTvSnapshot } from './tv-snapshot.js';

const job: JobDefinition = {
  name: 'tv-snapshot',
  description: 'First stage of the tv-recommendations workflow. It connects to Plex via the shared ' +
    'plex-client (self-healing a changed DHCP IP if needed), reads the configured TV library section, and ' +
    'builds a per-show snapshot keyed by TMDB GUID — resolving each owned show to its TMDB id so later ' +
    'stages can verify recommendations against it. Alongside the snapshot it computes a taste profile from ' +
    'the whole owned library: genre counts, creator/actor role counts, decade distribution, and country ' +
    'distribution. Writes data/out/snapshot.json (the per-show list) and data/out/taste-profile.json (the ' +
    'aggregate profile), which feed every one of the 8 recommender branches that fan out from this stage ' +
    'and, downstream, tv-rec-merge\'s TMDB verification.',
  timeoutMs: 300_000,
  maxRetries: 3,
  produces: [tvSnapshotContract()],
  async run(ctx) {
    await runTvSnapshot(ctx);
  },
};

export default job;
