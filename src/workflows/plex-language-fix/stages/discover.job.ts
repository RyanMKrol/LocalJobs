import type { JobDefinition } from '../../../core/types.js';
import { plexLanguageDiscoverContract } from '../contracts.js';
import { discoverInputKeys, runDiscover } from './discover.js';

const job: JobDefinition = {
  name: 'plex-language-discover',
  description:
    'Root stage of the plex-language-fix workflow. Walks every configured Plex library section (movie ' +
    '+ TV, and an optional third "downloadable" section only when explicitly enabled) and records every ' +
    'file (a movie, or a TV episode) on the work_items ledger, keyed by "<itemRatingKey>::part<partId>" ' +
    'together with the title\'s tmdb id extracted from its own Plex Guid. This is entirely read-only — it ' +
    'never mutates Plex and makes no TMDB call. It always walks the whole library fresh so newly added ' +
    'files are found, but a file already known from a prior run is never re-recorded: idempotency for the ' +
    'workflow\'s expensive/mutating stages (TMDB lookup, apply) rests on each of THOSE stages processing a ' +
    'file exactly once, ever, not on this one skipping the walk. Declares inputKeys(), making this the ' +
    'workflow\'s limitable root — a manual run-limit selects among files this ledger already knows about.',
  timeoutMs: 3_600_000,
  maxRetries: 3,
  produces: [plexLanguageDiscoverContract()],
  inputKeys: discoverInputKeys,
  async run(ctx) {
    await runDiscover(ctx);
  },
};

export default job;
