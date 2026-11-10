import { defineStage } from '../../../engine/index.js';
import { appliedChanges, discoveredFiles, languageDecisions } from '../contracts.js';
import { runApply } from './apply.js';

export default defineStage({
  name: 'plex-language-apply',
  description:
    'Reads every file plex-language-evaluate flagged status="change" and, for each not already applied by ' +
    'a PRIOR run of this stage, applies the proposed audio (and, when set, subtitle) stream selection via ' +
    'Plex\'s own official "PUT /library/parts/<id>" endpoint — the SAME call Plex\'s own clients make when ' +
    'a user manually picks a track. There is no ambiguous/needs-review carve-out: every change entry is ' +
    'applied the same way using evaluate\'s best-judgment pick, since the owner explicitly chose full ' +
    'unattended automation over a per-run manual sign-off. PERMANENT idempotency: once a file is recorded ' +
    'done here it is NEVER automatically re-touched by a future run, even if evaluate later re-flags it ' +
    '"change" — re-applying requires the operator to manually unstick this job\'s ledger row for that file. ' +
    'Before the first real change of a run, it triggers a Plex Butler on-demand database backup as a safety ' +
    'net (a failed trigger only logs a warning — it does not block applying). Every file is recorded on the ' +
    'work_items ledger (success or failed) and a self-contained per-run applied-changes log is written to ' +
    'data/out/applied-log-<timestamp>.json recording each file\'s before AND after audio/subtitle ' +
    'selection, which the manual, never-scheduled scripts/plex-language-undo.ts can replay to revert. A run ' +
    'with any failed file fails the run itself so it does not silently look clean.',
  timeoutMs: 3_600_000,
  maxRetries: 3,
  // The decisions from evaluate, and the files from discover (each file's Plex ids),
  // which is why the manifest gives this stage an edge from discover as well. The
  // decisions are checked before this stage starts: a malformed "change" row stops
  // the run before anything in Plex is touched.
  inputs: {
    decisions: { artifact: languageDecisions },
    files: { artifact: discoveredFiles },
  },
  outputs: { applied: { artifact: appliedChanges } },
  // What this workflow is for: the files it has fixed.
  product: true,
  async run(ctx) {
    await runApply(ctx);
  },
});
