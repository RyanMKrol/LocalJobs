import type { JobContext } from '../../../core/types.js';
import { markWorkItem } from '../../../db/store.js';
import { mountKeeperConfig } from '../config.js';
import { mountState, parseShares, realMount, removeStaleMountDir, type MountFn, type MountState, type ShareConfig } from '../lib.js';

export const JOB_NAME = 'mount-keeper-check';

/** Injectable seams for tests. */
export interface CheckOverrides {
  shares?: ShareConfig[];
  getState?: typeof mountState;
  removeStale?: typeof removeStaleMountDir;
  mount?: MountFn;
  now?: () => string;
}

/** The per-share ledger detail — a snapshot re-recorded every run. */
export interface CheckDetail {
  name: string;
  url: string;
  mountPoint: string;
  action: 'already-mounted' | 'remounted' | 'failed';
  stateBefore: MountState;
  error?: string;
  at: string;
}

/**
 * Check every configured share's mount and remount the missing ones. Per
 * share: healthy (exists + non-empty) → nothing to do; a stale EMPTY dir at
 * the mount point is rmdir'd first (plain rmdir — structurally incapable of
 * deleting files — and without this, macOS would silently mount the share at
 * "<name> - 1", breaking every path that references the real name); then
 * `mount volume` via osascript (Keychain-authenticated, like Finder), and the
 * mount point is re-verified healthy afterwards. Every share's outcome is
 * recorded on the ledger as a snapshot (re-marked each run); any share that
 * cannot be brought up fails the run so the workflow notification fires.
 */
export async function runCheck(ctx: JobContext, opts: CheckOverrides = {}): Promise<void> {
  const shares = opts.shares ?? parseShares(mountKeeperConfig.sharesRaw);
  const getState = opts.getState ?? mountState;
  const removeStale = opts.removeStale ?? removeStaleMountDir;
  const mount = opts.mount ?? realMount;
  const now = opts.now ?? (() => new Date().toISOString());

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`mount-keeper-check starting — ${shares.length} configured share(s).`);
  if (shares.length === 0) {
    ctx.log('MOUNT_KEEPER_SHARES is unset/empty — nothing to keep mounted. Set it in .env (see .env.example).', 'warn');
    ctx.progress(100, 'no shares configured');
    return;
  }

  let healthy = 0;
  let remounted = 0;
  let failed = 0;

  for (let i = 0; i < shares.length; i++) {
    const share = shares[i];
    if (!ctx.rootAllowed(share.mountPoint)) continue;
    const record = (action: CheckDetail['action'], stateBefore: MountState, error?: string) => {
      const detail: CheckDetail = { name: share.name, url: share.url, mountPoint: share.mountPoint, action, stateBefore, error, at: now() };
      markWorkItem(JOB_NAME, share.mountPoint, action === 'failed' ? 'failed' : 'success', { detail });
    };

    const before = await getState(share.mountPoint);
    if (before === 'healthy') {
      healthy++;
      ctx.log(`  ✓ "${share.name}" already mounted and healthy at ${share.mountPoint}`);
      record('already-mounted', before);
      ctx.progress(Math.round((100 * (i + 1)) / shares.length), `${i + 1}/${shares.length} checked`);
      continue;
    }

    ctx.log(`  ✗ "${share.name}" not healthy at ${share.mountPoint} (${before}) — remounting…`, 'warn');
    if (before === 'stale-empty-dir') {
      const removed = await removeStale(share.mountPoint);
      ctx.log(
        removed
          ? `    removed stale empty mountpoint dir ${share.mountPoint} (would otherwise divert the mount to "${share.name} - 1")`
          : `    could not remove stale mountpoint dir ${share.mountPoint} — the mount may divert to "${share.name} - 1"`,
        removed ? 'info' : 'warn',
      );
    }
    if (before === 'not-a-dir') {
      failed++;
      ctx.log(`    ${share.mountPoint} exists but is not a directory — refusing to touch it; investigate manually`, 'error');
      record('failed', before, 'mount point exists but is not a directory');
      continue;
    }

    try {
      await mount(share.url);
      const after = await getState(share.mountPoint);
      if (after === 'healthy') {
        remounted++;
        ctx.log(`  ✓ "${share.name}" remounted and verified healthy`);
        record('remounted', before);
      } else {
        failed++;
        ctx.log(`  ✗ "${share.name}" mount command succeeded but ${share.mountPoint} is ${after} — it may have mounted under a diverted name ("${share.name} - 1"); investigate`, 'error');
        record('failed', before, `post-mount state: ${after} (possible diverted mount name)`);
      }
    } catch (err) {
      failed++;
      const error = err instanceof Error ? err.message : String(err);
      ctx.log(`  ✗ "${share.name}" mount failed — ${error}`, 'error');
      record('failed', before, error);
    }
    ctx.progress(Math.round((100 * (i + 1)) / shares.length), `${i + 1}/${shares.length} checked`);
  }

  ctx.log('═══════════════ MOUNT-KEEPER SUMMARY ═══════════════');
  ctx.log(`Healthy: ${healthy} · remounted: ${remounted} · failed: ${failed}`);
  ctx.log('══════════════════════════════════════════════════');
  ctx.progress(100, `${healthy} healthy, ${remounted} remounted, ${failed} failed`);
  if (failed > 0) {
    throw new Error(`${failed}/${shares.length} share(s) could not be brought up — see logs above`);
  }
}
