import { defineStage, fromChecks, inlineArtifact } from '../../../engine/index.js';
import { runCheck, type MountStatus } from './check.js';

/** The state of every configured share after a run. Small, so it is kept in the run record. */
export const mountStatus = inlineArtifact<MountStatus>({
  key: 'mount-status',
  description: 'Every configured network share after this run: already mounted, remounted, or failed.',
  check: (v) => fromChecks([{ label: 'lists the shares it checked', ok: Array.isArray(v?.shares), actual: Array.isArray(v?.shares) ? `${v.shares.length} share(s)` : 'no list' }]),
  summary: (v) => `${v.healthy} healthy, ${v.remounted} remounted, ${v.failed} failed`,
  items: (v) => v.shares.map((s) => ({
    id: s.mountPoint,
    title: s.name,
    status: s.action === 'failed' ? 'failed' : 'success',
    fields: [
      { label: 'Mount point', value: s.mountPoint },
      { label: 'Action', value: s.action },
      { label: 'Was', value: s.stateBefore },
      ...(s.error ? [{ label: 'Error', value: s.error }] : []),
    ],
  })),
});

export default defineStage({
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
    'password is ever stored or read by this repo — and the mount point is re-verified healthy. The ' +
    'state of every share is the stage\'s output, committed even when a share could not be brought up, ' +
    'in which case the run then fails so the workflow\'s aggregate notification fires.',
  timeoutMs: 300_000,
  maxRetries: 2,
  outputs: { status: { artifact: mountStatus } },
  async run(ctx) {
    // Committed from inside the check, before it throws for a failed share.
    await runCheck(ctx, { report: (status) => ctx.output('status').write(status) });
  },
});
