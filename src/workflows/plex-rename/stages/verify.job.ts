import type { JobDefinition } from '../../../core/types.js';
import { plexRenamePlanContract, plexRenameVerifyContract } from '../contracts.js';
import { runVerify } from './verify.js';

const job: JobDefinition = {
  name: 'plex-rename-verify',
  description:
    'The local-disk reality check for every planned rename — the only read stage that touches the ' +
    'filesystem (through the metered fs service, via the SMB mounts of the NAS shares). Per candidate it ' +
    'asserts the disk is exactly as expected before the item may ever reach the mutating apply stage: the ' +
    'share mount is present AND healthy (a stale empty mountpoint is treated as "mount missing", never as ' +
    'deleted files) on BOTH sides — a consolidating move reads one share and writes another, so the '
    + 'target share is checked too — the Plex-side paths map to local ones, the source file exists with ' +
    'exactly the size Plex recorded, its mtime is older than the still-downloading window (default 7 days), ' +
    'the target does not already exist (case-only renames excepted), sidecars/assets are enumerated from ' +
    'the REAL directory listing with collision checks, and no .plexmatch would ever be renamed under or ' +
    'clobbered. Records an eligible/ineligible verdict with a precise reason per item, recomputed every ' +
    'run. Read-only — it stats and lists, never changes anything.',
  timeoutMs: 1_800_000,
  maxRetries: 3,
  consumes: [plexRenamePlanContract()],
  produces: [plexRenameVerifyContract()],
  async run(ctx) {
    await runVerify(ctx);
  },
};

export default job;
