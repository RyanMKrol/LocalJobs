import type { JobDefinition } from '../../../core/types.js';
import { runCheck } from './check.js';

const job: JobDefinition = {
  name: 'mount-keeper-check',
  description:
    'Keeps the configured SMB network shares mounted on this Mac. macOS mounts network shares lazily ' +
    '(clicking one in Finder mounts it) and drops them on reboot or sometimes when idle — but other ' +
    'workflows, most importantly plex-rename, need the NAS shares reliably present at /Volumes/<name> ' +
    'when they run. Each run walks the MOUNT_KEEPER_SHARES list (smb:// URLs, env-only since the share ' +
    'names describe this machine\'s topology) and, per share: a mount point that exists and is non-empty ' +
    'counts as healthy and is left alone; a stale EMPTY directory at the mount point is removed first ' +
    'with a plain rmdir (it cannot delete files, and without this macOS would silently divert the mount ' +
    'to "<name> - 1", breaking every configured path), then the share is mounted via osascript\'s ' +
    '"mount volume" — the same mechanism Finder uses, authenticating from the login Keychain, so no ' +
    'password is ever stored or read by this repo — and the mount point is re-verified healthy. Every ' +
    'share\'s outcome is recorded as a per-share ledger snapshot (re-marked each run), and a share that ' +
    'cannot be brought up fails the run so the workflow\'s aggregate notification fires.',
  timeoutMs: 300_000,
  maxRetries: 2,
  async run(ctx) {
    await runCheck(ctx);
  },
};

export default job;
