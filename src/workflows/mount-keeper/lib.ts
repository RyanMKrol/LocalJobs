// Helpers for the mount-keeper workflow: share-URL parsing, mount-point health,
// and the injectable mount seam. All real IO routes through callService('fs')
// (health checks, stale-dir cleanup) or the injectable mounter (osascript).
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { promisify } from 'node:util';
import { callService } from '../../core/services.js';

const execFileAsync = promisify(execFile);

export interface ShareConfig {
  /** The smb:// URL to mount, e.g. "smb://User@host/Share Name". */
  url: string;
  /** Where macOS mounts it: /Volumes/<share name> (the URL's last path segment, URL-decoded). */
  mountPoint: string;
  /** The share's display name (the last path segment). */
  name: string;
}

/**
 * Parse the `MOUNT_KEEPER_SHARES` env var — smb:// URLs joined by `;` (share
 * names contain spaces but never `;`). The mount point is derived from the
 * URL's last path segment, exactly where macOS's own `mount volume` puts it.
 * Malformed entries are dropped (the job logs the configured count, so a
 * silently-dropped entry is visible as a count mismatch).
 */
export function parseShares(raw: string | undefined): ShareConfig[] {
  if (!raw) return [];
  const shares: ShareConfig[] = [];
  for (const chunk of raw.split(';')) {
    const url = chunk.trim();
    if (!url.toLowerCase().startsWith('smb://')) continue;
    const lastSlash = url.lastIndexOf('/');
    if (lastSlash <= 'smb://'.length - 1) continue;
    const name = decodeURIComponent(url.slice(lastSlash + 1)).trim();
    if (!name) continue;
    shares.push({ url, mountPoint: `/Volumes/${name}`, name });
  }
  return shares;
}

/** What a mount point currently looks like on disk. */
export type MountState = 'healthy' | 'stale-empty-dir' | 'absent' | 'not-a-dir';

/**
 * A mount point is healthy only when it exists, is a directory, AND is
 * non-empty — the same rule plex-rename's verify stage applies. An EMPTY
 * directory at the mount point is the classic stale-mountpoint trap, and it's
 * actively dangerous here: `mount volume` would silently mount the share at
 * "<name> - 1" instead, breaking every path map that references the real name.
 */
export async function mountState(mountPoint: string): Promise<MountState> {
  return callService('fs', async () => {
    let st;
    try {
      st = await fsp.stat(mountPoint);
    } catch {
      return 'absent' as const;
    }
    if (!st.isDirectory()) return 'not-a-dir' as const;
    const entries = await fsp.readdir(mountPoint);
    return entries.length > 0 ? ('healthy' as const) : ('stale-empty-dir' as const);
  });
}

/** Remove a stale EMPTY mountpoint dir (plain rmdir — fails on non-empty, never deletes files). */
export async function removeStaleMountDir(mountPoint: string): Promise<boolean> {
  return callService('fs', async () => {
    try {
      await fsp.rmdir(mountPoint);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * The injectable mount seam. The real implementation shells out to
 * `osascript -e 'mount volume "<url>"'` — the same mechanism Finder uses, so
 * it authenticates from the login Keychain (where the owner's NAS credentials
 * already live from mounting these shares by hand). Requires the daemon to run
 * in the user's GUI session, which the launchd agent does. Never stores or
 * reads a password itself. Throws on a non-zero exit (wrong credentials, NAS
 * unreachable, user session unavailable).
 */
export type MountFn = (url: string) => Promise<void>;

export const realMount: MountFn = async (url) => {
  // AppleScript string literals escape only backslash and double-quote; the
  // URL is owner-configured, but escape defensively anyway.
  const escaped = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  await execFileAsync('osascript', ['-e', `mount volume "${escaped}"`], { timeout: 60_000 });
};
