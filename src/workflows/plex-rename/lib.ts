// Shared helpers for the plex-rename workflow: LIVE (never-cached) Plex reads,
// Plex-side ↔ local-side path mapping, the injectable filesystem seam, and the
// mount health check. No stage calls node:fs or plexGet directly — everything
// routes through these seams so tests never touch a live Plex or the real disk.
import { promises as fsp } from 'node:fs';
import { callService } from '../../core/services.js';
import { plexGet } from '../../core/plex-client.js';
import { pathKey } from './naming.js';
import type { PathMapPair, PlexMetadataItem, PlexSection } from './types.js';

// ── LIVE Plex reads ────────────────────────────────────────────────────────────
//
// Every helper here deliberately passes NO cacheKey to callService('plex', ...):
// a rename pipeline must never plan off a stale (up-to-3-hour-old) cached
// listing — a cached Part.file could describe a path that has already moved.
// This is a conscious divergence from plex-language-fix's cached reads.

type PlexFetcher = <T>(path: string) => Promise<T>;

interface PlexListResponse<T> {
  MediaContainer: { Metadata?: T[]; Directory?: T[] };
}

export async function fetchSections(fetchPlex: PlexFetcher = plexGet): Promise<PlexSection[]> {
  const res = await callService('plex', () => fetchPlex<PlexListResponse<PlexSection>>('/library/sections'));
  return (res.MediaContainer.Directory ?? []).filter((s) => s.type === 'movie' || s.type === 'show');
}

export async function fetchSectionItems(
  sectionKey: string,
  type: string,
  fetchPlex: PlexFetcher = plexGet,
): Promise<{ ratingKey: string; title: string }[]> {
  const plexType = type === 'movie' ? 1 : 2;
  const res = await callService('plex', () =>
    fetchPlex<PlexListResponse<{ ratingKey: string; title: string }>>(`/library/sections/${sectionKey}/all?type=${plexType}`),
  );
  return res.MediaContainer.Metadata ?? [];
}

export async function fetchItemDetail(
  ratingKey: string,
  fetchPlex: PlexFetcher = plexGet,
): Promise<PlexMetadataItem | undefined> {
  const res = await callService('plex', () => fetchPlex<PlexListResponse<PlexMetadataItem>>(`/library/metadata/${ratingKey}`));
  return res.MediaContainer.Metadata?.[0];
}

export async function fetchAllLeaves(
  showRatingKey: string,
  fetchPlex: PlexFetcher = plexGet,
): Promise<{ ratingKey: string; title: string; index?: number; parentIndex?: number }[]> {
  const res = await callService('plex', () =>
    fetchPlex<PlexListResponse<{ ratingKey: string; title: string; index?: number; parentIndex?: number }>>(
      `/library/metadata/${showRatingKey}/allLeaves`,
    ),
  );
  return res.MediaContainer.Metadata ?? [];
}

// ── Path mapping ───────────────────────────────────────────────────────────────

/** Map a Plex-side path to its local (mounted) equivalent, or null when no prefix matches. */
export function plexToLocal(plexPath: string, map: PathMapPair[]): string | null {
  const key = pathKey(plexPath);
  let best: PathMapPair | null = null;
  for (const pair of map) {
    const prefix = pathKey(pair.plex);
    if (key === prefix || key.startsWith(`${prefix}/`)) {
      if (!best || pair.plex.length > best.plex.length) best = pair;
    }
  }
  if (!best) return null;
  return best.local + plexPath.slice(best.plex.length);
}

/** The map pair a Plex-side path falls under, or null — used for the same-share (cross-share) check. */
export function shareOf(plexPath: string, map: PathMapPair[]): PathMapPair | null {
  const key = pathKey(plexPath);
  let best: PathMapPair | null = null;
  for (const pair of map) {
    const prefix = pathKey(pair.plex);
    if (key === prefix || key.startsWith(`${prefix}/`)) {
      if (!best || pair.plex.length > best.plex.length) best = pair;
    }
  }
  return best;
}

// ── Filesystem seam ────────────────────────────────────────────────────────────

export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

export interface FsDirEntry {
  name: string;
  isDir: boolean;
}

/**
 * The read-only filesystem seam the verify stage runs through. Every real call
 * is metered via `callService('fs', ...)` (call-count visibility + per-job
 * consumer tracking, like every other shared dependency). Tests inject fakes.
 * `stat`/`readdir` resolve null on ENOENT (a missing path is data, not an
 * exception) and THROW on any other error (EIO on a sick mount must never be
 * misread as "file missing").
 */
export interface ReadFsSeam {
  stat(path: string): Promise<FsStat | null>;
  readdir(path: string): Promise<FsDirEntry[] | null>;
  readFile(path: string): Promise<string | null>;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

export const realReadFs: ReadFsSeam = {
  async stat(path) {
    return callService('fs', async () => {
      try {
        const st = await fsp.stat(path);
        return { isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    });
  },
  async readdir(path) {
    return callService('fs', async () => {
      try {
        const entries = await fsp.readdir(path, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    });
  },
  async readFile(path) {
    return callService('fs', async () => {
      try {
        return await fsp.readFile(path, 'utf8');
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    });
  },
};

// ── Mount health ───────────────────────────────────────────────────────────────

/**
 * A mapped local share root is healthy only when it exists, is a directory,
 * AND is non-empty — an unmounted SMB share often leaves (or autofs creates) a
 * stale EMPTY directory at the mount point, which a bare existence check would
 * happily accept and then misread every file as deleted. Non-empty is cheap
 * and unambiguous: a real media share always has content.
 */
export async function mountHealthy(localRoot: string, fs: ReadFsSeam): Promise<boolean> {
  const st = await fs.stat(localRoot);
  if (!st || !st.isDirectory) return false;
  const entries = await fs.readdir(localRoot);
  return entries !== null && entries.length > 0;
}
