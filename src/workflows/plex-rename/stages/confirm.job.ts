import type { JobDefinition } from '../../../core/types.js';
import { plexRenameApplyContract } from '../contracts.js';
import { runConfirm } from './confirm.js';

const job: JobDefinition = {
  name: 'plex-rename-confirm',
  description:
    'Post-rename verification that Plex itself re-associated each moved file at the SAME ratingKey, so ' +
    'watch state, collections, and metadata survived the rename. For every applied-but-not-yet-confirmed ' +
    'item it fetches the item\'s live metadata (never cached) and compares the reported file path against ' +
    'the rename target: a match confirms the item once and forever; the old path still showing means Plex ' +
    'simply has not rescanned yet, recorded as a soft retryable state and re-checked on every run until ' +
    'the PLEX_RENAME_CONFIRM_GRACE_DAYS window (default 14 days) expires, at which point it fails loud; ' +
    'and a ratingKey that no longer resolves fails loud immediately — that is the workflow\'s worst ' +
    'failure mode (Plex re-imported the file as a NEW item, orphaning its watch state), which the separate ' +
    'plex-library-guard workflow independently detects too. A run with any confirmation failure fails ' +
    'itself, so the aggregate workflow notification surfaces it.',
  timeoutMs: 1_800_000,
  maxRetries: 3,
  consumes: [plexRenameApplyContract()],
  async run(ctx) {
    await runConfirm(ctx);
  },
};

export default job;
