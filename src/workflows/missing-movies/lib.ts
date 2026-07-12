import { mkdirSync, writeFileSync } from 'node:fs';
import { missingMoviesConfig } from './config.js';

export function ensureDirs(): void {
  for (const d of [missingMoviesConfig.outDir, missingMoviesConfig.reportDir]) mkdirSync(d, { recursive: true });
}

export function writeJsonFile(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
}
