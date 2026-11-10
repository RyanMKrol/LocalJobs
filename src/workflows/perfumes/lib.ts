import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { callService } from '../../core/services.js';
import { ensureDirs as coreEnsureDirs, readJsonFile, writeFileAtomic, writeJsonFile } from '../../engine/index.js';
import { dynamoScan } from '../../services/dynamodb.service.js';
import { perfumesConfig } from './config.js';
import type { PerfumeInput } from './types.js';

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

export { readJsonFile, writeFileAtomic, writeJsonFile };

export function ensureDirs(): void {
  coreEnsureDirs(perfumesConfig.outDir, perfumesConfig.pagesDir, perfumesConfig.pagesFailedDir, perfumesConfig.fragranticaDir, perfumesConfig.markdownDir);
}

export const label = (p: PerfumeInput): string => `${p.name} — ${p.brand}`;

/**
 * Display fields for a ledger row on the run page: each `[label, value]` pair
 * whose value is present, then the error when the row is a failed one. Used by
 * the stages' `describeItem`.
 */
export function rowFields(detail: Record<string, unknown>, pairs: [string, unknown][]): { label: string; value: string }[] {
  const out = pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([l, v]) => ({ label: l, value: String(v) }));
  if (typeof detail.error === 'string' && detail.error) out.push({ label: 'Error', value: detail.error.slice(0, 160) });
  if (typeof detail.stopped === 'string' && detail.stopped) out.push({ label: 'Stopped', value: detail.stopped });
  return out;
}

/** Every parsed Fragrantica perfume's vote count, across the whole scraped
 *  corpus (the `data/out/fragrantica/*.json` files). This is the ecosystem-wide
 *  sample of how much community signal exists, used to calibrate what counts as
 *  a high- vs low-confidence vote count. Skips files with no usable vote count
 *  and anything unreadable. */
export function loadVoteCorpus(dir: string = perfumesConfig.fragranticaDir): number[] {
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
