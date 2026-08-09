import type { JobDefinition } from '../../../core/types.js';
import { runVaultExport } from './export.js';

const job: JobDefinition = {
  name: 'vault-sync-export',
  description: 'Copies the markdown output of the nine source jobs across six workflows (places, perfumes, ' +
    'plex-profiles, listening-digest, workouts-sync, and the four media-reviews categories) into the ' +
    'second-brain vault folder, one subfolder per source (Places, Perfumes, Plex/Movies, Plex/TV, ' +
    'Listening, Workouts, Reviews/Books, Reviews/Movies, Reviews/TV, Reviews/Albums) with prettified ' +
    'filenames like "10 Cloverfield Lane (2016).md". For each source ledger row it compares the row\'s ' +
    'last-updated timestamp against the marker recorded at the previous sync and re-copies only what ' +
    'changed (or what was deleted from the vault by hand), so a steady-state run is a cheap database ' +
    'scan that writes nothing. The vault is a read-only mirror: copies are overwritten when their ' +
    'source changes, originals never move, and nothing is ever deleted from the vault — a vanished ' +
    'source item just leaves its vault copy behind and is logged. Every source writes one surviving ' +
    'file per ledger row (workouts has been per-month files since 2026-08), so no source needs ' +
    'special-casing; a few legacy workouts rows closed out as unrecoverable under the old ' +
    'single-slot layout simply stay closed out.',
  timeoutMs: 600_000,
  maxRetries: 2,
  async run(ctx) {
    await runVaultExport(ctx);
  },
};

export default job;
