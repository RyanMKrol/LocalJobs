import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { plexConfig } from './config.js';

export function ensureDirs(): void {
  for (const d of [plexConfig.outDir, plexConfig.reportDir]) mkdirSync(d, { recursive: true });
}

export function readJsonFile<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
}

export function writeJsonFile(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/**
 * Format a sorted season list into compact ranges: [8,9,10] → "S8–S10",
 * [4] → "S4", [4,6] → "S4, S6", [4,5,7] → "S4–S5, S7". Used in the digest push.
 */
export function formatSeasonRanges(seasons: number[]): string {
  const sorted = [...new Set(seasons)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `S${sorted[i]}` : `S${sorted[i]}–S${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(', ');
}
