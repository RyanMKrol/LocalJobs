import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { QuotaExceededError, callService } from '../../../core/services.js';
import type { JobContext } from '../../../core/types.js';
import { tmdbGet } from '../../plex/client.js';
import { moviesConfig } from '../config.js';
import { ensureDirs, writeJsonFile } from '../lib.js';
import { buildOwnedSet } from '../movies.js';
import {
  RECS_JOB,
  balanceByGenre,
  dedupeRawByTitleYear,
  genreNameFromIds,
  mergeLens,
  recKey,
} from '../recs.js';
import { isWorkItemDone } from '../../../db/store.js';
import type {
  BranchOutputFile,
  MovieSnapshotFile,
  RawSuggestion,
  Recommendation,
  RecommendationsFile,
  TmdbSearchResponse,
  TmdbSearchResult,
} from '../types.js';

/** TMDB title search (injectable for tests). Returns the best match or null. */
export type SearchMovieFn = (title: string, year: number | null) => Promise<TmdbSearchResult | null>;

const defaultSearchMovie: SearchMovieFn = (title, year) =>
  callService('tmdb', async () => {
    const params = new URLSearchParams({ query: title, include_adult: 'false' });
    if (year != null) params.set('year', String(year));
    const resp = await tmdbGet<TmdbSearchResponse>(`/search/movie?${params.toString()}`);
    return resp.results?.[0] ?? null;
  });

export interface MergeOpts {
  searchMovie?: SearchMovieFn;
  snapshotFile?: string;
  recsDir?: string;
  recsOut?: string;
  now?: Date;
}

/** Read every branch's output file from the recs dir, pooling raw suggestions. */
function poolBranchSuggestions(recsDir: string, ctx: JobContext): RawSuggestion[] {
  if (!existsSync(recsDir)) return [];
  const pooled: RawSuggestion[] = [];
  for (const f of readdirSync(recsDir).filter((n) => n.endsWith('.json'))) {
    try {
      const file = JSON.parse(readFileSync(join(recsDir, f), 'utf8')) as BranchOutputFile;
      const n = file.suggestions?.length ?? 0;
      ctx.log(`  • ${file.branchId} (${file.lens}) — ${n} suggestion(s)${file.error ? ` [${file.error}]` : ''}`);
      if (Array.isArray(file.suggestions)) pooled.push(...file.suggestions);
    } catch (err) {
      ctx.log(`  ✗ could not read branch file ${f} — ${err instanceof Error ? err.message : err}`, 'warn');
    }
  }
  return pooled;
}

/**
 * Merge stage — CODE enforces correctness so the LLM can't invent or re-suggest.
 * Pools all branches' raw suggestions, then for each (after a cheap title/year
 * dedup): TMDB-searches it → must resolve to a REAL tmdb id → must NOT be owned →
 * must NOT already be recommended/ignored (the `movie-recs` ledger, keyed by
 * recommended tmdb id). Dedupes across branches by resolved tmdb id (merging
 * lenses), then BALANCES the output (cap per genre, ~target total) so the digest
 * isn't one flavour. Writes data/out/recommendations.json. Resilient: per-item
 * search failures are skipped and a TMDB quota stops it gracefully — it always
 * writes a (possibly empty) list and succeeds, so the notify stage still runs.
 */
export async function runMerge(ctx: JobContext, opts: MergeOpts = {}): Promise<void> {
  ensureDirs();
  const search = opts.searchMovie ?? defaultSearchMovie;
  const snapshotFile = opts.snapshotFile ?? moviesConfig.snapshotOut;
  const recsDir = opts.recsDir ?? moviesConfig.recsDir;
  const recsOut = opts.recsOut ?? moviesConfig.recsOut;
  const now = opts.now ?? new Date();

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('rec-merge starting');
  if (!existsSync(snapshotFile)) {
    throw new Error(`snapshot.json not found — run movie-snapshot first (${snapshotFile}).`);
  }
  const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8')) as MovieSnapshotFile;
  const owned = buildOwnedSet(snapshot.movies ?? []);
  ctx.log(`Owned set size ${owned.size}.`);

  ctx.log('Pooling branch suggestions…');
  const pooled = poolBranchSuggestions(recsDir, ctx);
  const unique = dedupeRawByTitleYear(pooled);
  ctx.log(`Pooled ${pooled.length} raw suggestion(s) → ${unique.length} after title/year dedup.`);

  const byTmdb = new Map<number, Recommendation>();
  let searches = 0;
  let dropHallucinated = 0;
  let dropOwned = 0;
  let dropAlready = 0;
  let quotaHit = false;

  for (let i = 0; i < unique.length; i++) {
    const s = unique[i];
    ctx.progress((i / Math.max(unique.length, 1)) * 90, `verified ${i}/${unique.length}`);
    let result: TmdbSearchResult | null;
    try {
      result = await search(s.title, s.year);
      searches++;
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        ctx.log(`tmdb ${err.window} cap reached (${err.used}/${err.cap}) — stopping verification gracefully.`, 'warn');
        quotaHit = true;
        break;
      }
      ctx.log(`  ✗ "${s.title}" — search failed: ${err instanceof Error ? err.message.split('\n')[0] : err}`, 'warn');
      continue;
    }
    if (!result || typeof result.id !== 'number') {
      dropHallucinated++;
      ctx.log(`  ⨯ "${s.title}"${s.year ? ` (${s.year})` : ''} — no TMDB match (hallucinated) — dropped.`, 'warn');
      continue;
    }
    const tmdbId = result.id;
    if (owned.has(tmdbId)) { dropOwned++; ctx.log(`  ⨯ "${s.title}" → tmdb ${tmdbId} — already OWNED — dropped.`); continue; }
    if (isWorkItemDone(RECS_JOB, recKey(tmdbId), 1)) {
      dropAlready++;
      ctx.log(`  ⨯ "${s.title}" → tmdb ${tmdbId} — already recommended/ignored — dropped.`);
      continue;
    }
    const existing = byTmdb.get(tmdbId);
    if (existing) { mergeLens(existing, s.lens); continue; }
    byTmdb.set(tmdbId, {
      tmdbId,
      title: result.title ?? s.title,
      year: result.release_date ? Number(result.release_date.slice(0, 4)) || s.year : s.year,
      reason: s.reason,
      lens: s.lens,
      genre: genreNameFromIds(result.genre_ids),
      tmdbRating: typeof result.vote_average === 'number' ? result.vote_average : null,
    });
  }

  const verified = [...byTmdb.values()];
  const balanced = balanceByGenre(verified, { cap: moviesConfig.recsGenreCap, target: moviesConfig.recsTarget });

  const out: RecommendationsFile = { generatedAt: now.toISOString(), pooled: pooled.length, recommendations: balanced };
  writeJsonFile(recsOut, out);

  ctx.progress(100, `${balanced.length} recommendation(s)`);
  ctx.log('');
  ctx.log('═══════════════ REC-MERGE SUMMARY ═══════════════');
  ctx.log(`Pooled ${pooled.length} · unique ${unique.length} · TMDB searches ${searches}${quotaHit ? ' (stopped on quota)' : ''}.`);
  ctx.log(`Dropped: ${dropHallucinated} hallucinated · ${dropOwned} owned · ${dropAlready} already-recommended.`);
  ctx.log(`Verified novel: ${verified.length} → balanced to ${balanced.length} (cap ${moviesConfig.recsGenreCap}/genre, target ${moviesConfig.recsTarget}).`);
  for (const r of balanced) ctx.log(`  • [${r.genre}] ${r.title}${r.year ? ` (${r.year})` : ''} — ${r.reason} (${r.lens})`);
  ctx.log(`Wrote ${recsOut}`);
  ctx.log('══════════════════════════════════════════════════');
}
