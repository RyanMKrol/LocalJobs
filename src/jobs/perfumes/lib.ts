import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** Every parsed Fragrantica perfume's vote count, across the whole scraped
 *  corpus (the `data/out/fragrantica/*.json` files). This is the ecosystem-wide
 *  sample of how much community signal exists, used to calibrate what counts as
 *  a high- vs low-confidence vote count. Skips files with no usable vote count
 *  and anything unreadable. */
export function loadVoteCorpus(): number[] {
  const dir = perfumesConfig.fragranticaDir;
  if (!existsSync(dir)) return [];
  const out: number[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { votes?: unknown };
      if (typeof d.votes === 'number' && Number.isFinite(d.votes) && d.votes > 0) out.push(d.votes);
    } catch {
      /* unreadable / non-JSON file — skip it, it just doesn't contribute a sample */
    }
  }
  return out;
}
