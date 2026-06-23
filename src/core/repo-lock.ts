// repo-lock.ts — the SHARED advisory lock used by both the autonomous loop
// (.harness/loop.sh) and the daemon API so their git operations are mutually
// exclusive. It is an mkdir-based lock DIRECTORY with a `pid` file inside,
// living at `<git-common-dir>/<basename(repo-root)>-loop.lock`.
//
// ⚠️ The lock path MUST stay byte-identical to loop.sh's `acquire_lock`:
//   ROOT       = git -C <cwd> rev-parse --show-toplevel
//   GIT_COMMON = git -C <ROOT> rev-parse --git-common-dir   (made absolute: ROOT/<rel> if relative)
//   LOCK       = $GIT_COMMON/$(basename "$ROOT")-loop.lock   (with a `pid` file inside)
// loop.sh and the daemon must agree on this path or the two writers could run
// concurrently. If you change the derivation here, change loop.sh's `acquire_lock`
// (and `GIT_COMMON`/`NAME` derivation) in the same commit, and vice-versa.
//
// The stale-pid-reclaim protocol also mirrors loop.sh: if the lock dir exists but
// its `pid` names a process that is no longer alive, the lock is reclaimed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

export interface RepoPaths {
  /** Absolute repo root (`git rev-parse --show-toplevel`). */
  root: string;
  /** Absolute git common dir (`git rev-parse --git-common-dir`, made absolute). */
  gitCommonDir: string;
  /** Absolute lock-directory path (the same path loop.sh's `acquire_lock` uses). */
  lockDir: string;
}

/**
 * Resolve the repo root, git-common-dir, and the shared lock-dir path for `cwd`,
 * matching loop.sh's derivation exactly. Throws if `cwd` is not inside a git repo.
 */
export function resolveRepoPaths(cwd: string): RepoPaths {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  let gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  if (!isAbsolute(gitCommonDir)) gitCommonDir = join(root, gitCommonDir); // make absolute (loop.sh: ROOT/$GIT_COMMON)
  const lockDir = join(gitCommonDir, `${basename(root)}-loop.lock`);
  return { root, gitCommonDir, lockDir };
}

/** True if a signal-0 to `pid` succeeds (process exists, possibly not ours → EPERM). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists but owned by another user
  }
}

/** Read the owner PID written inside the lock dir, or null if absent/unreadable. */
function readOwnerPid(pidFile: string): number | null {
  try {
    const n = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** A small async sleep that does NOT block the event loop. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AcquireOptions {
  /** Explicit lock-dir (tests). Otherwise derived from `cwd` via {@link resolveRepoPaths}. */
  lockDir?: string;
  /** cwd used to derive the lock dir when `lockDir` is omitted. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Max time to wait for a held lock before throwing. Default 30s. */
  timeoutMs?: number;
  /** Poll interval while waiting on a live holder. Default 100ms. */
  pollMs?: number;
  /** PID written into the lock (tests). Defaults to `process.pid`. */
  pid?: number;
}

/**
 * Acquire the shared repo lock, returning a release function. Mirrors loop.sh:
 * mkdir the lock dir (atomic create), reclaim it if the recorded PID is dead,
 * otherwise wait (up to `timeoutMs`) for the live holder to release. The returned
 * release is idempotent and only removes the lock if WE still own it (PID match).
 */
export async function acquireRepoLock(opts: AcquireOptions = {}): Promise<() => void> {
  const lockDir = opts.lockDir ?? resolveRepoPaths(opts.cwd ?? process.cwd()).lockDir;
  const pidFile = join(lockDir, 'pid');
  const pid = opts.pid ?? process.pid;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      mkdirSync(lockDir); // throws EEXIST if already held — the atomic claim
      writeFileSync(pidFile, `${pid}\n`);
      return makeRelease(lockDir, pidFile, pid);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const owner = readOwnerPid(pidFile);
      if (owner !== null && !processAlive(owner)) {
        // Stale holder (dead PID) — reclaim, then retry the mkdir.
        try { rmSync(pidFile, { force: true }); } catch { /* ignore */ }
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`could not acquire repo lock ${lockDir} (held by PID ${owner ?? '?'})`);
      }
      await delay(pollMs);
    }
  }
}

function makeRelease(lockDir: string, pidFile: string, pid: number): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Only release if WE still own it (loop.sh's release_lock does the same PID check).
    if (readOwnerPid(pidFile) !== pid) return;
    try { rmSync(pidFile, { force: true }); } catch { /* ignore */ }
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
}
