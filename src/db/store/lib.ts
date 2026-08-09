import { realpathSync } from 'node:fs';
import { isAbsolute, relative as relativePath, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The workflows tree (src/workflows), resolved relative to this file — mirrors
// src/api/server.ts's WORKFLOWS_ROOT. A workflow's `data/out/` folder lives
// under here. Storing `detail.markdown`/`detail.path` RELATIVE to this root
// (rather than a frozen absolute path) means a future workflow-folder rename
// can't strand already-recorded ledger rows, the way the src/jobs -> src/workflows
// rename did (T447).
const WORKFLOWS_ROOT = realpathSync(fileURLToPath(new URL('../../workflows', import.meta.url)));

/**
 * Given an absolute path under {@link WORKFLOWS_ROOT}, return it made relative to
 * that root (e.g. `plex-space-saver/data/out/size-breakdown.json`). A path that
 * isn't absolute, or isn't under the root, is returned unchanged (defensive —
 * don't mangle something unexpected).
 */
export function toStoredPath(absPath: string): string {
  if (!isAbsolute(absPath)) return absPath;
  const rel = relativePath(WORKFLOWS_ROOT, resolvePath(absPath));
  if (rel.startsWith('..') || isAbsolute(rel)) return absPath; // not under the root — leave alone
  return rel.split(sep).join('/');
}

/**
 * Inverse of {@link toStoredPath}: resolve a stored workflows-root-relative path
 * back to an absolute one. An absolute input (a legacy pre-T447 row, or an
 * artifact deliberately recorded outside the workflows tree) passes through
 * unchanged. The same conversion is inlined in src/api/server.ts's
 * `safeOutputMarkdown`/`safeOutputFile`; this is the shared helper for any
 * non-API consumer of a ledger row's `detail.markdown`/`detail.path`.
 */
export function fromStoredPath(stored: string): string {
  return isAbsolute(stored) ? stored : resolvePath(WORKFLOWS_ROOT, stored);
}

/**
 * Normalize the two known path-bearing `detail` keys (`markdown`/`path`, per the
 * Output-form convention) to workflows-root-relative paths before persisting, so
 * every job's existing markWorkItem call sites need zero changes (T447).
 */
export function normalizeDetailPaths(detail: unknown): unknown {
  if (detail === undefined || detail === null || typeof detail !== 'object' || Array.isArray(detail)) return detail;
  const obj = detail as Record<string, unknown>;
  if (typeof obj.markdown !== 'string' && typeof obj.path !== 'string') return detail;
  const out = { ...obj };
  if (typeof obj.markdown === 'string') out.markdown = toStoredPath(obj.markdown);
  if (typeof obj.path === 'string') out.path = toStoredPath(obj.path);
  return out;
}
