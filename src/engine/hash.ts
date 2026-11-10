// Content fingerprints for committed artifacts: used to tell whether a file a
// stage handed on is still the file the next stage is about to read, and whether
// a re-written artifact actually changed.
import { createHash } from 'node:crypto';
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** SHA-256 of a file's bytes, read in chunks (hand-off files can be tens of MB). */
export function sha256File(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface DirStats {
  /** Fingerprint of the directory's file LISTING: each file's name, size and mtime. */
  sha256: string;
  /** Total bytes across the files directly inside. */
  bytes: number;
  /** The newest mtime among the directory and its files (ms). */
  mtimeMs: number;
  files: number;
}

/**
 * Fingerprint a directory of per-item files without reading their contents
 * (there can be thousands): name + size + mtime of each regular file directly
 * inside. Any file added, removed, resized or rewritten changes it. `belongs`
 * limits it to the files that are part of the artifact (see `ArtifactType.files`).
 */
export function dirStats(path: string, belongs?: (name: string) => boolean): DirStats {
  const hash = createHash('sha256');
  let bytes = 0;
  let files = 0;
  // With a `belongs` filter the directory is shared: its own mtime moves when ANY
  // file in it is added or removed, so only the matching files' mtimes count.
  let mtimeMs = belongs ? 0 : statSync(path).mtimeMs;
  const names = readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isFile() && (!belongs || belongs(e.name)))
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    const st = statSync(join(path, name));
    hash.update(`${name}\0${st.size}\0${Math.floor(st.mtimeMs)}\n`);
    bytes += st.size;
    files += 1;
    if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
  }
  return { sha256: hash.digest('hex'), bytes, mtimeMs, files };
}
