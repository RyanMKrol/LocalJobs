// Shared JSON-file + directory helpers (T588) — deduped out of perfumes/movies/tv-recs/plex-space-saver's lib.ts.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Read + parse a JSON file, or return `fallback` when the file does not exist.
 * A file that exists but does not parse is a real fault (a truncated write, a
 * hand-edit gone wrong), so it throws, and the error NAMES the file: a bare
 * "Unexpected end of JSON input" from deep inside a stage is useless for
 * finding which of a workflow's hand-off files is broken.
 */
export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
}

/**
 * Write a file ATOMICALLY: write to a temp file in the same directory, fsync it,
 * then rename over the target. A reader (another stage, another workflow, the
 * dashboard) therefore sees either the complete old file or the complete new one,
 * never a half-written one, and a process killed mid-write leaves the previous
 * file intact. Every hand-off file between stages must be written this way: a
 * plain `writeFileSync` truncates the target first, so a kill at the wrong moment
 * used to leave a file that broke every later run until someone repaired it.
 */
export function writeFileAtomic(path: string, content: string | Uint8Array): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w');
    if (typeof content === 'string') writeSync(fd, content);
    else writeSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already failing; keep the original error */ }
    }
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Serialize `data` as pretty JSON and write it atomically (see {@link writeFileAtomic}). */
export function writeJsonFile(path: string, data: unknown): void {
  writeFileAtomic(path, JSON.stringify(data, null, 2));
}

export function ensureDirs(...dirs: string[]): void {
  for (const d of dirs) mkdirSync(d, { recursive: true });
}
