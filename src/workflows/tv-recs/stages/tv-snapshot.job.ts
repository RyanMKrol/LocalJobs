import { defineStage } from '../../../engine/index.js';
import { tvRecsConfig } from '../config.js';
import { tvArtifacts } from '../contracts.js';
import { runTvSnapshot } from './tv-snapshot.js';

export default defineStage({
  name: 'tv-snapshot',
  description: 'First stage of the tv-recommendations workflow. It connects to Plex via the shared ' +
    'plex-client (self-healing a changed DHCP IP if needed), reads the configured TV library section, and ' +
    'builds a per-show snapshot keyed by TMDB GUID — resolving each owned show to its TMDB id so later ' +
    'stages can verify recommendations against it. Alongside the snapshot it computes a taste profile from ' +
    'the whole owned library: genre counts, role counts (Plex\'s Role tags), decade distribution, and country ' +
    'distribution. Writes data/out/snapshot.json (the per-show list) and data/out/taste-profile.json (the ' +
    'aggregate profile), which feed every one of the 8 recommender branches that fan out from this stage ' +
    'and tv-rec-merge, which reads both directly. It writes no ledger rows.',
  timeoutMs: 300_000,
  maxRetries: 3,
  // Both files are rebuilt from Plex on every run, and both must be: a run that
  // returned without writing either fails here rather than handing the branches
  // last month's library.
  outputs: {
    snapshot: { artifact: tvArtifacts.snapshot, location: () => tvRecsConfig.snapshotOut },
    taste: { artifact: tvArtifacts.taste, location: () => tvRecsConfig.tasteOut },
  },
  async run(ctx) {
    await runTvSnapshot(ctx);
  },
});
