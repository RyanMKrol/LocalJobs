// Shared JSON-file + directory helpers (T588) — deduped out of perfumes/movies/tv-recs/plex-space-saver's lib.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export function readJsonFile<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
}

export function writeJsonFile(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export function ensureDirs(...dirs: string[]): void {
  for (const d of dirs) mkdirSync(d, { recursive: true });
}
