import { defineStage } from '../../../engine/index.js';
import { discoveredFiles } from '../contracts.js';
import { discoverInputKeys, runDiscover } from './discover.js';

export default defineStage({
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
    'workflow\'s limitable root. The candidates for a manual run-limit come from a live walk of the ' +
    'library, not from this ledger.',
  // Three hours. The walk makes about 30,000 Plex calls and the plex service allows 300 a
  // minute, so a walk with nothing cached takes about 100 minutes. This was one hour, so
  // every night the first attempt was killed at 60 minutes and the retry finished the job
  // from the response cache the first attempt had filled: the same total time, plus a
  // "timeout" row on every run page.
  timeoutMs: 10_800_000,
  maxRetries: 3,
  // The stage's ledger rows are its output: one per file, added to as the library grows.
  outputs: { files: { artifact: discoveredFiles } },
  inputKeysService: 'plex',
  inputKeys: discoverInputKeys,
  async run(ctx) {
    await runDiscover(ctx);
  },
});
