import type { JobDefinition } from '../../../core/types.js';
import { plexRenameDiscoverContract } from '../contracts.js';
import { discoverInputKeys, runDiscover } from './discover.js';

const job: JobDefinition = {
  name: 'plex-rename-discover',
  description:
    'Root stage of the plex-rename workflow. Walks the configured Plex movie + TV library sections LIVE ' +
    '(deliberately never cached — a rename pipeline must never plan off a stale listing) and records one ' +
    'work_items row per physical file, keyed "<ratingKey>::part<partId>", carrying everything the naming ' +
    'engine needs: the current Plex-side file path and size, the title\'s tmdb/tvdb/imdb ids from its own ' +
    'Plex Guids, movie year/edition, episode season/episode/title/air-date (multi-episode files are grouped ' +
    'into one row listing every episode they represent), and the library root the file lives under, taken ' +
    'from Plex\'s own section Location paths. Rows are SNAPSHOTS re-recorded on every run — after a rename ' +
    'is applied and Plex rescans, the refreshed path is how the pipeline converges to already-canonical. ' +
    'Entirely read-only; never touches the filesystem or mutates Plex. Declares inputKeys() (a live walk, ' +
    'never a ledger read-back), making this the workflow\'s limitable root.',
  timeoutMs: 3_600_000,
  maxRetries: 3,
  produces: [plexRenameDiscoverContract()],
  inputKeysService: 'plex',
  inputKeys: discoverInputKeys,
  async run(ctx) {
    await runDiscover(ctx);
  },
};

export default job;
