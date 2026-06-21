import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { getWorkItem } from '../../db/store.js';
import { perfumesConfig } from './config.js';
import type { PerfumeInput } from './types.js';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function loadPerfumes(): PerfumeInput[] {
  return JSON.parse(readFileSync(perfumesConfig.inputFile, 'utf8')) as PerfumeInput[];
}

export function readJsonFile<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
}

export function writeJsonFile(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export function ensureDirs(): void {
  for (const d of [perfumesConfig.outDir, perfumesConfig.pagesDir, perfumesConfig.pagesFailedDir, perfumesConfig.fragranticaDir, perfumesConfig.markdownDir]) {
    mkdirSync(d, { recursive: true });
  }
}

/** A perfume is "stuck" at a stage if it failed and is out of retries. */
export function isStuck(jobName: string, id: string): boolean {
  const r = getWorkItem(jobName, id);
  return !!r && r.status === 'failed' && r.attempts >= perfumesConfig.maxAttempts;
}

export const label = (p: PerfumeInput): string => `${p.name} — ${p.brand}`;
