// Shared helpers for the plex-rename workflow: LIVE (never-cached) Plex reads,
// Plex-side ↔ local-side path mapping, the injectable filesystem seams (read
// AND write), and the mount health check. No stage calls node:fs or plexGet
// directly — everything routes through these seams so tests never touch a live
// Plex or the real disk.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
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

/**
 * One section listing with `includeGuids=1` — the FULL per-item payload
 * (Guid[], year, Media[].Part[].file/size/id, numbering) in a single call.
 * This is deliberately the ONLY per-title data source for movies and the
 * show-level source for TV: a verified live check against the owner's server
 * confirmed the listing carries everything the naming engine needs, so
 * discover never pays a per-item `/library/metadata/<key>` fetch (which once
 * made the TV walk take hours — ~1 call per EPISODE at the service rate cap).
 */
export async function fetchSectionItems(
  sectionKey: string,
  type: string,
  fetchPlex: PlexFetcher = plexGet,
): Promise<PlexMetadataItem[]> {
  const plexType = type === 'movie' ? 1 : 2;
  const res = await callService('plex', () =>
    fetchPlex<PlexListResponse<PlexMetadataItem>>(`/library/sections/${sectionKey}/all?type=${plexType}&includeGuids=1`),
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

/**
 * All of a show's episode leaves in ONE call — and the leaves carry their full
 * Media[].Part[] (file/size/id) plus numbering/title/air-date (live-verified),
 * so discover needs exactly one request per show, never one per episode.
 */
export async function fetchAllLeaves(showRatingKey: string, fetchPlex: PlexFetcher = plexGet): Promise<PlexMetadataItem[]> {
  const res = await callService('plex', () =>
    fetchPlex<PlexListResponse<PlexMetadataItem>>(`/library/metadata/${showRatingKey}/allLeaves`),
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

/**
 * The WRITE-side filesystem seam — used only by the mutating apply stage and
 * the manual undo script, never by a read stage. Same ENOENT-is-data /
 * everything-else-throws contract as ReadFsSeam. Every real call is metered
 * via `callService('fs', ...)`.
 *
 * `copyStreamHashed` is the heart of the copy-verify-delete move procedure:
 * it streams src → dest while SHA-256-hashing the READ stream (so the hash is
 * of the SOURCE bytes actually read), fsyncs the destination before resolving,
 * and returns the hash + byte count. `hashFile` re-reads a file from disk to
 * hash what was actually WRITTEN — the verify step compares the two.
 */
export interface WriteFsSeam extends ReadFsSeam {
  copyStreamHashed(src: string, dest: string): Promise<{ sha256: string; bytes: number }>;
  hashFile(path: string): Promise<{ sha256: string; bytes: number } | null>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  /** rmdir ONLY when a fresh readdir shows empty — structurally incapable of deleting files. */
  rmdirIfEmpty(path: string): Promise<'removed' | 'not-empty' | 'missing'>;
  /** Free + total bytes of the volume containing `path`, or null when unknowable
   *  (SMB mounts report the NAS volume's real capacity — verified live). */
  volumeUsage(path: string): Promise<{ free: number; total: number } | null>;
}

export const realWriteFs: WriteFsSeam = {
  ...realReadFs,
  async copyStreamHashed(src, dest) {
    return callService('fs', async () => {
      const hash = createHash('sha256');
      let bytes = 0;
      const read = createReadStream(src);
      read.on('data', (chunk: string | Buffer) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        hash.update(buf);
        bytes += buf.length;
      });
      const write = createWriteStream(dest, { flags: 'wx' }); // 'wx': never overwrite an existing partial
      await pipeline(read, write);
      const fh = await fsp.open(dest, 'r');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      return { sha256: hash.digest('hex'), bytes };
    });
  },
  async hashFile(path) {
    return callService('fs', async () => {
      try {
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of createReadStream(path)) {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
          hash.update(buf);
          bytes += buf.length;
        }
        return { sha256: hash.digest('hex'), bytes };
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    });
  },
  async rename(from, to) {
    return callService('fs', () => fsp.rename(from, to));
  },
  async unlink(path) {
    return callService('fs', () => fsp.unlink(path));
  },
  async mkdirp(path) {
    await callService('fs', () => fsp.mkdir(path, { recursive: true }));
  },
  async writeFile(path, content) {
    return callService('fs', async () => {
      await fsp.mkdir(dirname(path), { recursive: true });
      await fsp.writeFile(path, content, 'utf8');
    });
  },
  async volumeUsage(path) {
    return callService('fs', async () => {
      try {
        const st = await fsp.statfs(path);
        return { free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize) };
      } catch {
        return null;
      }
    });
  },
  async rmdirIfEmpty(path) {
    return callService('fs', async () => {
      let entries: string[];
      try {
        entries = await fsp.readdir(path);
      } catch (err) {
        if (isEnoent(err)) return 'missing' as const;
        throw err;
      }
      if (entries.length > 0) return 'not-empty' as const;
      try {
        await fsp.rmdir(path); // plain rmdir: fails on a race-filled dir rather than deleting anything
        return 'removed' as const;
      } catch (err) {
        if (typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
          return 'not-empty' as const;
        }
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
