import { defineStage, fromChecks, inlineArtifact } from '../../../engine/index.js';
import { SOURCE_JOBS } from '../lib.js';
import { runVaultExport, type VaultExportResult } from './export.js';

/**
 * The vault is outside the repo, so the stage's output is not the folder itself
 * but what this run did to it.
 */
export const vaultExportResult = inlineArtifact<VaultExportResult>({
  key: 'vault-export-result',
  description: 'What this run did to the vault: how many files were copied in, and how many were already up to date.',
  check: (v) => fromChecks([{ label: 'has counts', ok: typeof v?.synced === 'number' && typeof v?.unchanged === 'number', actual: `${v?.synced} copied` }]),
  summary: (v) => `${v.synced} copied, ${v.unchanged} unchanged`,
});

export default defineStage({
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
  outputs: { result: { artifact: vaultExportResult } },
  // The other workflows' ledgers this stage reads. Declared so the registry refuses to
  // load if one of those jobs is renamed or removed, instead of this stage quietly
  // finding nothing to copy for it.
  reads: [...SOURCE_JOBS],
  describeItem: (dt) => ({
    title: String(dt.name ?? ''),
    fields: [
      ...(typeof dt.vaultPath === 'string' ? [{ label: 'In the vault', value: dt.vaultPath }] : []),
      ...(typeof dt.error === 'string' ? [{ label: 'Error', value: dt.error.slice(0, 160) }] : []),
    ],
  }),
  async run(ctx) {
    ctx.output('result').write(await runVaultExport(ctx));
  },
});
