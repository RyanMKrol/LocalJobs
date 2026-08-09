import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { callService } from '../../../core/services.js';
import { getWorkItem, markWorkItem } from '../../../db/store.js';
import type { JobContext } from '../../../core/types.js';
import { dynamoScan } from '../../../services/dynamodb.service.js';
import { mediaReviewsConfig } from '../config.js';
import {
  contentMarker,
  renderAlbumReview,
  renderBookReview,
  renderMovieReview,
  renderTvReview,
  slugStem,
} from '../lib.js';
import type { RenderedReview, ReviewCategory } from '../types.js';

/**
 * One category's wiring for the generic engine below. `table`/`outDir` are
 * read at CALL time (functions, not values) so tests can redirect the config
 * singleton's outDirs to a temp dir before running.
 */
export interface CategorySpec {
  jobName: string;
  /** Singular label for log lines, e.g. 'book'. */
  label: string;
  table: () => string;
  outDir: () => string;
  /** Raw Dynamo item → rendered markdown + names, or null when malformed. */
  render: (raw: Record<string, unknown>) => RenderedReview | null;
}

export const CATEGORY_SPECS: Record<ReviewCategory, CategorySpec> = {
  books: {
    jobName: 'media-reviews-books',
    label: 'book',
    table: () => mediaReviewsConfig.booksTable,
    outDir: () => mediaReviewsConfig.booksOutDir,
    render: renderBookReview,
  },
  movies: {
    jobName: 'media-reviews-movies',
    label: 'movie',
    table: () => mediaReviewsConfig.moviesTable,
    outDir: () => mediaReviewsConfig.moviesOutDir,
    render: renderMovieReview,
  },
  tv: {
    jobName: 'media-reviews-tv',
    label: 'TV show',
    table: () => mediaReviewsConfig.tvTable,
    outDir: () => mediaReviewsConfig.tvOutDir,
    render: renderTvReview,
  },
  albums: {
    jobName: 'media-reviews-albums',
    label: 'album',
    table: () => mediaReviewsConfig.albumsTable,
    outDir: () => mediaReviewsConfig.albumsOutDir,
    render: renderAlbumReview,
  },
};

export interface BuildOpts {
  /**
   * Injectable table scan (tests) — swaps in for the real
   * `callService('dynamodb', () => dynamoScan(table), { cacheKey })` so the
   * engine runs without AWS. Defaults to the real cached scan.
   */
  scan?: (table: string) => Promise<Record<string, unknown>[]>;
}

interface WorkItemDetail {
  name?: string;
  markdown?: string;
  marker?: string;
}

function readStoredMarker(jobName: string, itemKey: string): string | undefined {
  const row = getWorkItem(jobName, itemKey);
  if (!row?.detail) return undefined;
  try {
    return (JSON.parse(row.detail) as WorkItemDetail).marker;
  } catch {
    return undefined;
  }
}

/** The real scan path: one metered, response-cached (22h TTL) full table Scan
 *  via the shared read-only dynamodb service — the perfumes idiom, one
 *  distinct cacheKey per table. */
function cachedScan(table: string): Promise<Record<string, unknown>[]> {
  return callService('dynamodb', () => dynamoScan(table), { cacheKey: `dynamodb:scan:${table}` });
}

/**
 * Generic single-stage build shared by all four review categories: scan the
 * category's DynamoDB table (read-only), and write one markdown file per
 * review into the category's `data/out/` subfolder — but only for reviews
 * that are NEW or whose raw item content actually changed since the last
 * successful write. Change detection is a sha256 content hash of the whole
 * raw item (`contentMarker` in lib.ts) stored in the work_items ledger's
 * `detail.marker` — deliberately NOT the row's `editedDate`, which the site's
 * metadata backfills bypass. Mirrors plex-profiles' `updatedAt`-marker build
 * shape (`src/workflows/plex-profiles/stages/build.ts`).
 *
 * Rows with no usable string `id` (a handful of legacy site rows may predate
 * the id migration) and rows missing a required field are warn-logged and
 * skipped without a ledger row (perfumes' malformed-row precedent) — they
 * don't fail the run. A genuine per-item failure (render/write error) marks
 * that item failed and, per the T416 rule, fails the run at the end.
 */
export async function runReviewBuild(ctx: JobContext, spec: CategorySpec, opts: BuildOpts = {}): Promise<void> {
  const table = spec.table();
  const outDir = spec.outDir();
  mkdirSync(outDir, { recursive: true });
  const scan = opts.scan ?? cachedScan;

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log(`${spec.jobName} starting — scanning DynamoDB table ${table} (read-only, paginated).`);
  ctx.progress(5, `scanning ${table}`);

  const items = await scan(table);
  ctx.log(`Scanned ${items.length} item(s) from ${table}.`);

  interface Candidate {
    id: string;
    raw: Record<string, unknown>;
    marker: string;
  }

  const candidates: Candidate[] = [];
  let skippedNoId = 0;
  for (const raw of items) {
    const id = raw.id;
    if (typeof id !== 'string' || !id) {
      skippedNoId++;
      ctx.log(`warn: skipping ${spec.label} row with no usable id: ${JSON.stringify(raw).slice(0, 200)}`, 'warn');
      continue;
    }
    candidates.push({ id, raw, marker: contentMarker(raw) });
  }

  const allowed = candidates.filter((c) => ctx.rootAllowed(c.id));

  // Decide which need (re)writing — new id, or the content hash has moved.
  const needsBuild: Candidate[] = [];
  let skippedUnchanged = 0;
  for (const c of allowed) {
    const stored = readStoredMarker(spec.jobName, c.id);
    if (stored !== undefined && stored === c.marker) {
      skippedUnchanged++;
      continue;
    }
    needsBuild.push(c);
  }
  if (skippedUnchanged > 0) {
    ctx.log(`${skippedUnchanged} ${spec.label} review(s) unchanged since last run — skipped.`);
  }
  ctx.log(`Plan: ${needsBuild.length} to (re)write, ${skippedUnchanged} unchanged, ${skippedNoId} skipped (no id), out of ${items.length} scanned.`);

  let written = 0;
  let skippedMalformed = 0;
  let failed = 0;
  const total = needsBuild.length;

  for (let i = 0; i < total; i++) {
    const c = needsBuild[i];
    try {
      const rendered = spec.render(c.raw);
      if (!rendered) {
        skippedMalformed++;
        ctx.log(`warn: skipping malformed ${spec.label} item ${c.id} (missing required fields): ${JSON.stringify(c.raw).slice(0, 200)}`, 'warn');
        continue;
      }
      const outPath = resolve(outDir, `${slugStem(rendered.stem, c.id)}.md`);
      writeFileSync(outPath, rendered.md);
      ctx.log(`Wrote ${rendered.name} → ${outPath} (${i + 1}/${total})`);
      markWorkItem(spec.jobName, c.id, 'success', {
        detail: { name: rendered.name, markdown: outPath, marker: c.marker },
      });
      written++;
    } catch (e) {
      ctx.log(`error: failed to write ${spec.label} review ${c.id}: ${String(e)}`, 'error');
      markWorkItem(spec.jobName, c.id, 'failed', { detail: { name: c.id } });
      failed++;
    }
    ctx.progress(10 + ((i + 1) / Math.max(total, 1)) * 85, `${i + 1}/${total} processed`);
  }

  ctx.log(
    `${spec.jobName} complete — ${written} written, ${skippedUnchanged} unchanged, ${skippedMalformed} malformed skipped, ` +
      `${skippedNoId} no-id skipped, ${failed} failed, out of ${items.length} scanned. Output: ${outDir}`,
  );
  ctx.progress(100, `${written} written, ${skippedUnchanged} unchanged, ${failed} failed`);

  if (failed > 0) {
    throw new Error(`${failed}/${total} ${spec.label} review(s) failed to write this run — see logs above`);
  }
}
