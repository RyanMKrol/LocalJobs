import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getWorkItem } from '../../db/store.js';
import type { JobContext } from '../../core/types.js';
import { callService } from '../../core/services.js';
import { dynamoScan } from '../../services/dynamodb.service.js';
import { perfumesConfig } from './config.js';
import type { PerfumeInput } from './types.js';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The live source of truth (T401): the owner's PerfumeRatings DynamoDB table,
 *  populated by rating perfumes on their own website. Retired the old
 *  hand-maintained `data/raw/perfumes.json` file entirely — the table's own
 *  `id` is used as-is as the new canonical perfume id (a deliberate
 *  idempotency-key change; see T401's spec for why no migration is needed). */
export async function loadPerfumes(): Promise<PerfumeInput[]> {
  const items = await callService('dynamodb', () => dynamoScan(perfumesConfig.perfumeRatingsTable), { cacheKey: `dynamodb:scan:${perfumesConfig.perfumeRatingsTable}` });
  const perfumes: PerfumeInput[] = [];
  for (const item of items) {
    const {
      id, title, designer, type, fragranticaUrl,
      description, rating, date, ownership, longevity, projection, seasons, applicationSpots,
    } = item as Record<string, unknown>;
    if (typeof id !== 'string' || typeof title !== 'string' || typeof designer !== 'string' || typeof type !== 'string') {
      console.warn(`[perfumes] warn: skipping malformed PerfumeRatings item: ${JSON.stringify(item)}`);
      continue;
    }
    perfumes.push({
      id,
      name: title,
      brand: designer,
      concentration: type,
      ...(typeof fragranticaUrl === 'string' && fragranticaUrl ? { fragranticaUrl } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      ...(typeof rating === 'number' && Number.isFinite(rating) ? { rating: rating / 2 } : {}),
      ...(typeof date === 'string' ? { dateAdded: date } : {}),
      ...(typeof ownership === 'string' ? { ownership: ownership as PerfumeInput['ownership'] } : {}),
      ...(typeof longevity === 'number' && Number.isFinite(longevity) ? { personalLongevity: longevity } : {}),
      ...(typeof projection === 'number' && Number.isFinite(projection) ? { personalProjection: projection } : {}),
      ...(Array.isArray(seasons) ? { personalSeasons: seasons } : {}),
      ...(Array.isArray(applicationSpots) ? { applicationSpots } : {}),
    });
  }
  return perfumes;
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

/**
 * Emit a per-item progress update for an item-loop stage: `done` of `total`
 * items finished maps to a 0..100 percentage, with an `done/total` status (plus
 * an optional suffix like "3 ok, 1 failed"). Centralises what every perfumes
 * stage does after each item so a long stage advances the run % AS IT WORKS
 * instead of jumping 0→100 only at the end. `total <= 0` (an empty run) reports
 * 100 rather than dividing by zero.
 */
export function reportItemProgress(
  ctx: Pick<JobContext, 'progress'>,
  done: number,
  total: number,
  suffix?: string,
): void {
  const pct = total > 0 ? (done / total) * 100 : 100;
  ctx.progress(pct, `${done}/${total}${suffix ? ` · ${suffix}` : ''}`);
}

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
