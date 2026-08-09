import type { JobDefinition } from '../../../core/types.js';
import { runVaultExport } from './export.js';

const job: JobDefinition = {
  name: 'vault-sync-export',
  description: 'Copies the markdown output of the five source workflows (places, perfumes, plex-profiles, ' +
    'listening-digest, workouts-sync) into the second-brain vault folder, one subfolder per source ' +
    '(Places, Perfumes, Plex/Movies, Plex/TV, Listening, Workouts) with prettified filenames like ' +
    '"10 Cloverfield Lane (2016).md". For each source ledger row it compares the row\'s last-updated ' +
    'timestamp against the marker recorded at the previous sync and re-copies only what changed (or ' +
    'what was deleted from the vault by hand), so a steady-state run is a cheap database scan that ' +
    'writes nothing. The vault is a read-only mirror: copies are overwritten when their source ' +
    'changes, originals never move, and nothing is ever deleted from the vault — a vanished source ' +
    'item just leaves its vault copy behind and is logged. The workouts report is a special case: ' +
    'its source file is a single slot overwritten every month, so only the latest month is ever ' +
    'synced and an older month\'s vault copy is never clobbered with newer content.',
  timeoutMs: 600_000,
  maxRetries: 2,
  async run(ctx) {
    await runVaultExport(ctx);
  },
};

export default job;
