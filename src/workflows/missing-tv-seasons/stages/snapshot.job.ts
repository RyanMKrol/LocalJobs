import type { JobDefinition } from '../../../core/types.js';
import { plexSnapshotContract } from '../contracts.js';
import { runSnapshot } from './snapshot.js';

const job: JobDefinition = {
  name: 'plex-tv-snapshot',
  description: 'Stage 1 of the weekly missing-TV-seasons audit. Connects to the Plex server (self-healing a changed DHCP IP via the shared plex-client if needed) and reads every show in the configured TV library section, matching each one by its tmdb:// GUID rather than a title guess so a show with no such GUID is explicitly flagged unverifiable instead of silently mismatched. For each show it records the title, TMDB id, and the highest REGULAR season it currently owns (season 0 specials are excluded from that calculation). This stage always re-scans the whole library from scratch on every run — it has no per-item skip-if-done state, since idempotency for this workflow lives only in the final notify stage — and writes the full result to data/out/snapshot.json for the next stage to consume.',
  timeoutMs: 300_000,
  maxRetries: 3,
  produces: [plexSnapshotContract()],
  async run(ctx) {
    await runSnapshot(ctx);
  },
};

export default job;
