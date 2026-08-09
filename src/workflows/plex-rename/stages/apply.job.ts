import type { JobDefinition } from '../../../core/types.js';
import { plexRenameApplyContract, plexRenameVerifyContract } from '../contracts.js';
import { runApply } from './apply.js';

const job: JobDefinition = {
  name: 'plex-rename-apply',
  description:
    'The workflow\'s only mutating stage — and it ships DISABLED: until PLEX_RENAME_APPLY_ENABLED=1 it runs ' +
    'in rehearsal mode, logging exactly what it would move and writing a REPORT-ONLY markdown, touching ' +
    'nothing. When enabled, it takes the verified-eligible items (up to the PLEX_RENAME_MAX_PER_DAY daily ' +
    'quota, default 30 media files, tracked on the job_usage meter), re-checks every precondition at the ' +
    'moment of truth (source present at the exact verified size, still older than the still-downloading ' +
    'window, target absent, enough free space for a transient second copy), and relocates each file with ' +
    'the copy -> checksum-verify -> delete-original procedure: stream-copy to a .plexrename-partial, ' +
    'SHA-256 verify the written copy against the source, atomically finalize to the real name, and only ' +
    'then delete the original — so an original is never deleted until a verified copy exists, and the ' +
    'worst crash outcome is a dead extra file. Every operation is recorded in a write-ahead NDJSON journal ' +
    '(fsynced BEFORE each filesystem effect; the manual scripts/plex-rename-undo.ts can replay it in ' +
    'reverse), an unresolved journal from a crashed run is reconciled against disk before any new work, a ' +
    'Plex Butler database backup fires before the first mutation, sidecars move in lockstep, the emptied ' +
    'source dir is removed only via rmdir-if-empty (structurally incapable of deleting files), and Plex is ' +
    'asked to rescan just the changed directories. Each file is applied at most once, EVER — redoing one ' +
    'requires manually unsticking its ledger row.',
  timeoutMs: 6 * 3_600_000,
  maxRetries: 1,
  consumes: [plexRenameVerifyContract()],
  produces: [plexRenameApplyContract()],
  async run(ctx) {
    await runApply(ctx);
  },
};

export default job;
