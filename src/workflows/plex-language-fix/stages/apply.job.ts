import type { JobDefinition } from '../../../core/types.js';
import { plexLanguageScanContract } from '../contracts.js';
import { runApply } from './apply.js';

const job: JobDefinition = {
  name: 'plex-language-apply',
  description:
    'Reads the proposed changeset from plex-language-scan and, for every file flagged status="change", ' +
    'applies the proposed audio (and, when set, subtitle) stream selection via Plex\'s own official ' +
    '"PUT /library/parts/<id>" endpoint — the SAME call Plex\'s own clients make when a user manually ' +
    'picks a track. There is no ambiguous/needs-review carve-out: every change entry, including what ' +
    'would previously have been a channel-count tie, is applied the same way using the scan stage\'s ' +
    'best-judgment pick, since the owner explicitly chose full unattended automation over a per-run ' +
    'manual sign-off. Before the first real change of a run, it triggers a Plex Butler on-demand database ' +
    'backup as a safety net (a failed trigger only logs a warning — it does not block applying). Every ' +
    'file is recorded on the work_items ledger (success or failed) and a self-contained per-run ' +
    'applied-changes log is written to data/out/applied-log-<timestamp>.json recording each file\'s before ' +
    'AND after audio/subtitle selection, which the manual, never-scheduled scripts/plex-language-undo.ts ' +
    'can replay to revert. A run with any failed file fails the run itself so it does not silently look clean.',
  timeoutMs: 3_600_000,
  maxRetries: 3,
  consumes: [plexLanguageScanContract()],
  async run(ctx) {
    await runApply(ctx);
  },
};

export default job;
