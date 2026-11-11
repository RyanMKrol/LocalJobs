import { defineStage } from '../../../engine/index.js';
import { plexConfig } from '../config.js';
import { plexTvSnapshot } from '../contracts.js';
import { runSnapshot } from './snapshot.js';

export default defineStage({
  name: 'plex-tv-snapshot',
  description: 'Stage 1 of the weekly missing-TV-seasons audit. Connects to the Plex server (self-healing a changed DHCP IP via the shared plex-client if needed) and reads every show in the configured TV library section, matching each one by its tmdb:// GUID rather than a title guess so a show with no such GUID is explicitly flagged unverifiable instead of silently mismatched. For each show it records the title, TMDB id, and the highest REGULAR season it currently owns (season 0 specials are excluded from that calculation). This stage always re-scans the whole library from scratch on every run. It has no per-item skip-if-done state and writes no ledger rows, since the only thing this workflow remembers between runs is what the final notify stage has announced. It writes the full result to data/out/snapshot.json for the next stage to read. If Plex returns no shows at all it fails without writing anything, so an empty read can never replace the last good snapshot.',
  timeoutMs: 300_000,
  maxRetries: 3,
  // Rebuilt from Plex on every run: a run that returned without writing it fails,
  // so the season check can never be handed last week's library.
  outputs: {
    snapshot: { artifact: plexTvSnapshot, location: () => plexConfig.snapshotOut },
  },
  async run(ctx) {
    await runSnapshot(ctx);
  },
});
