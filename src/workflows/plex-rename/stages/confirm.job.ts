import { defineStage } from '../../../engine/index.js';
import { appliedRenames, confirmedRenames, discoveredFiles } from '../contracts.js';
import { runConfirm } from './confirm.js';

export default defineStage({
  name: 'plex-rename-confirm',
  description:
    'Post-rename verification that Plex itself re-associated each moved file, so watch state, collections, ' +
    'and metadata survived the rename. For every applied-but-not-yet-confirmed item it fetches the ' +
    'item\'s live metadata (never cached) and compares the reported file path against the rename target: a ' +
    'match at the same ratingKey confirms the item once and forever; the old path still showing means Plex ' +
    'simply has not rescanned yet, recorded as a soft retryable state and re-checked on every run until ' +
    'the PLEX_RENAME_CONFIRM_GRACE_DAYS window (default 14 days) expires, at which point it fails loud. A ' +
    'ratingKey that no longer resolves is checked against this run\'s discover snapshot: if a Plex item ' +
    'with matching ids sits at exactly the target path, the file is confirmed as re-associated (the normal ' +
    'result of merging a show Plex held as two entries). If nothing is at the target path it waits out the ' +
    'same grace window and then fails loud: Plex has lost track of a moved file, which the separate ' +
    'plex-library-guard workflow independently detects too. It never touches a file. Its only writes ' +
    're-select, on a confirmed item and its season and show, the artwork that was showing before the move. ' +
    'A run with any confirmation failure fails itself, so the aggregate workflow notification surfaces it.',
  timeoutMs: 1_800_000,
  maxRetries: 3,
  inputs: {
    applied: { artifact: appliedRenames },
    files: { artifact: discoveredFiles },
  },
  outputs: { confirmed: { artifact: confirmedRenames } },
  async run(ctx) {
    await runConfirm(ctx);
  },
});
