import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tvRecsConfig } from './config.js';

export function ensureDirs(): void {
  for (const d of [tvRecsConfig.outDir, tvRecsConfig.recsDir]) mkdirSync(d, { recursive: true });
}

export function readJsonFile<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
}

export function writeJsonFile(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
}
