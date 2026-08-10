// TEST-ONLY in-memory WriteFsSeam — shared by move.test.ts and
// scripts/plex-rename-undo.test.ts (kept as a real module so both suites use
// one implementation; nothing in production imports it). Content-addressed by
// exact path string; "directories" exist implicitly wherever a deeper path
// does. Supports fault injection for the checksum-mismatch paths.
import { createHash } from 'node:crypto';
import type { FsDirEntry, FsStat, WriteFsSeam } from './lib.js';

export interface MemFsOptions {
  /** Corrupt the bytes actually written by copyStreamHashed (simulates a bad copy). */
  corruptCopies?: boolean;
  /** Per-file mtimes (ms); default OLD (0). */
  mtimes?: Record<string, number>;
  /** Volume free/total bytes reported for every path (default: effectively unlimited + empty). */
  freeBytes?: number;
  totalBytes?: number;
}

export interface MemFs extends WriteFsSeam {
  files: Map<string, string>;
  /** Every mutating call, in order — for asserting operation ordering. */
  oplog: string[];
}

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function makeMemFs(initial: Record<string, string>, opts: MemFsOptions = {}): MemFs {
  const files = new Map(Object.entries(initial));
  const oplog: string[] = [];
  const isDir = (p: string) => [...files.keys()].some((f) => f.startsWith(`${p}/`));

  return {
    files,
    oplog,
    async stat(path): Promise<FsStat | null> {
      const f = files.get(path);
      if (f !== undefined) return { isFile: true, isDirectory: false, size: f.length, mtimeMs: opts.mtimes?.[path] ?? 0 };
      if (isDir(path)) return { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 };
      return null;
    },
    async readdir(path): Promise<FsDirEntry[] | null> {
      if (!isDir(path)) return null;
      const names = new Map<string, boolean>();
      for (const f of files.keys()) {
        if (!f.startsWith(`${path}/`)) continue;
        const rest = f.slice(path.length + 1);
        names.set(rest.split('/')[0], rest.includes('/'));
      }
      return [...names.entries()].map(([name, dir]) => ({ name, isDir: dir }));
    },
    async readFile(path) {
      return files.get(path) ?? null;
    },
    async copyStreamHashed(src, dest) {
      oplog.push(`copy:${src}→${dest}`);
      const content = files.get(src);
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${src}`), { code: 'ENOENT' });
      if (files.has(dest)) throw Object.assign(new Error(`EEXIST: ${dest}`), { code: 'EEXIST' });
      files.set(dest, opts.corruptCopies ? `${content}#CORRUPT` : content);
      return { sha256: sha(content), bytes: content.length };
    },
    async hashFile(path) {
      const content = files.get(path);
      if (content === undefined) return null;
      return { sha256: sha(content), bytes: content.length };
    },
    async rename(from, to) {
      oplog.push(`rename:${from}→${to}`);
      const content = files.get(from);
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' });
      files.delete(from);
      files.set(to, content);
    },
    async unlink(path) {
      oplog.push(`unlink:${path}`);
      if (!files.delete(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    },
    async mkdirp(path) {
      oplog.push(`mkdirp:${path}`);
    },
    async writeFile(path, content) {
      oplog.push(`write:${path}`);
      files.set(path, content);
    },
    async volumeUsage() {
      const free = opts.freeBytes ?? Number.MAX_SAFE_INTEGER / 2;
      return { free, total: opts.totalBytes ?? Number.MAX_SAFE_INTEGER };
    },
    async rmdirIfEmpty(path) {
      oplog.push(`rmdir-if-empty:${path}`);
      if (files.has(path)) throw new Error(`not a directory: ${path}`);
      if (isDir(path)) return 'not-empty';
      return 'missing';
    },
  };
}
