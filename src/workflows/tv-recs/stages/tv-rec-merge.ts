import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { QuotaExceededError, callService } from '../../../core/services.js';
import type { JobContext } from '../../../core/types.js';
import { tmdbGet } from '../../../core/plex-client.js';
import { tvRecsConfig } from '../config.js';
import { ensureDirs, writeJsonFile } from '../lib.js';
import {
  RECS_JOB,
  balanceByGenre,
  dedupeRawByTitleYear,
  mergeLens,
  normTitle,
  recKey,
} from '../recs.js';
import { runClaude } from '../../../services/claude.js';
import { BRANCHES } from './branches.js';
import { allHistoryTitles, collectBranchSuggestions, ignoredSuggestionTitles, recentTitles } from './recommend.js';
import type { RunClaudeFn } from './recommend.js';
import { isWorkItemDone } from '../../../db/store.js';
import type {
  BranchOutputFile,
  RawSuggestion,
  Recommendation,
  RecommendationsFile,
  TvSnapshotFile,
  TvTasteProfileFile,
} from '../types.js';

/** TMDB TV search result shape (the fields we use). */
export interface TmdbTvSearchResult {
  id: number;
  name?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  genre_ids?: number[];
}

export interface TmdbTvSearchResponse {
  results?: TmdbTvSearchResult[];
}

/** TMDB TV title search (injectable for tests). Returns the best match or null. */
export type SearchTvFn = (title: string, year: number | null) => Promise<TmdbTvSearchResult | null>;

/** Top-up source: re-prompt branches for more suggestions, excluding already-seen titles. */
export type TopUpFn = (exclude: string[], round: number) => Promise<RawSuggestion[]>;

// ── TMDB TV genre id → name (fixed public TMDB list) ──

const TMDB_TV_GENRES: Record<number, string> = {
  10759: 'Action & Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 10762: 'Kids',
  9648: 'Mystery', 10763: 'News', 10764: 'Reality', 10765: 'Sci-Fi & Fantasy',
  10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics', 37: 'Western',
};

function genreNameFromIds(ids: number[] | undefined): string {
  for (const id of ids ?? []) if (TMDB_TV_GENRES[id]) return TMDB_TV_GENRES[id];
  return 'Unknown';
}

const defaultSearchTv: SearchTvFn = (title, year) =>
  callService(
    'tmdb',
    async () => {
      const params = new URLSearchParams({ query: title, include_adult: 'false' });
      if (year != null) params.set('first_air_date_year', String(year));
      const resp = await tmdbGet<TmdbTvSearchResponse>(`/search/tv?${params.toString()}`);
      return resp.results?.[0] ?? null;
    },
    { cacheKey: `tmdb:search:tv:${title}${year != null ? `:${year}` : ''}` },
  );

export interface MergeOpts {
  searchTv?: SearchTvFn;
  topUp?: TopUpFn;
  runClaude?: RunClaudeFn;
  snapshotFile?: string;
  tasteFile?: string;
  historyFile?: string;
  recsDir?: string;
  recsOut?: string;
  now?: Date;
  minRating?: number;
  minVotes?: number;
  target?: number;
  genreCap?: number;
  topUpRounds?: number;
  topUpConcurrency?: number;
}

function displayTitle(s: RawSuggestion): string {
  return `${s.title}${s.year ? ` (${s.year})` : ''}`;
}

function rawKey(s: RawSuggestion): string {
  return `${normTitle(s.title)}::${s.year ?? ''}`;
}

interface VerifyCounters {
  searches: number;
  dropHallucinated: number;
  dropOwned: number;
  dropAlready: number;
  dropLowQuality: number;
  quotaHit: boolean;
  searchFailed: number;
}

interface MergeParams {
  minRating: number;
  minVotes: number;
  target: number;
  genreCap: number;
  topUpRounds: number;
}

async function runBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    let item: T | undefined;
    while ((item = queue.shift()) !== undefined) {
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function buildOwnedSet(shows: TvSnapshotFile['shows']): Set<number> {
  const s = new Set<number>();
  for (const show of shows) if (show.tmdbId != null) s.add(show.tmdbId);
  return s;
}

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

async function verifyInto(
  batch: RawSuggestion[],
  byTmdb: Map<number, Recommendation>,
  owned: Set<number>,
  search: SearchTvFn,
  ctx: JobContext,
  params: MergeParams,
  counters: VerifyCounters,
): Promise<void> {
  for (const s of batch) {
    let result: TmdbTvSearchResult | null;
    try {
      result = await search(s.title, s.year);
      counters.searches++;
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        ctx.log(`tmdb ${err.window} cap reached (${err.used}/${err.cap}) — stopping verification gracefully.`, 'warn');
        counters.quotaHit = true;
        return;
      }
      counters.searchFailed++;
      ctx.log(`  ✗ "${s.title}" — search failed: ${err instanceof Error ? err.message.split('\n')[0] : err}`, 'warn');
      continue;
    }
    if (!result || typeof result.id !== 'number') {
      counters.dropHallucinated++;
      ctx.log(`  ⨯ "${s.title}"${s.year ? ` (${s.year})` : ''} — no TMDB match (hallucinated) — dropped.`, 'warn');
      continue;
    }
    const tmdbId = result.id;
    if (owned.has(tmdbId)) { counters.dropOwned++; ctx.log(`  ⨯ "${s.title}" → tmdb ${tmdbId} — already OWNED — dropped.`); continue; }
    if (isWorkItemDone(RECS_JOB, recKey(tmdbId), 1)) {
      counters.dropAlready++;
      ctx.log(`  ⨯ "${s.title}" → tmdb ${tmdbId} — already recommended/ignored — dropped.`);
      continue;
    }
    const rating = typeof result.vote_average === 'number' ? result.vote_average : 0;
    const votes = typeof result.vote_count === 'number' ? result.vote_count : 0;
    if (rating < params.minRating || votes < params.minVotes) {
      counters.dropLowQuality++;
      ctx.log(`  ⨯ "${s.title}" → tmdb ${tmdbId} — rating ${rating} (${votes} votes) below bar (≥${params.minRating}, ≥${params.minVotes} votes) — dropped.`);
      continue;
    }
    const existing = byTmdb.get(tmdbId);
    if (existing) { mergeLens(existing, s.lens); continue; }
    const airDate = result.first_air_date;
    byTmdb.set(tmdbId, {
      tmdbId,
      title: result.name ?? s.title,
      year: airDate ? Number(airDate.slice(0, 4)) || s.year : s.year,
      reason: s.reason,
      lens: s.lens,
      genre: genreNameFromIds(result.genre_ids),
      tmdbRating: rating,
    });
  }
}

function buildDefaultTopUp(
  snapshot: TvSnapshotFile,
  tasteFile: string,
  historyFile: string,
  run: RunClaudeFn,
  ctx: JobContext,
  concurrency: number,
): TopUpFn {
  return async (exclude, round) => {
    if (!existsSync(tasteFile)) {
      ctx.log('  • top-up: no taste profile on disk — cannot re-prompt branches.', 'warn');
      return [];
    }
    const taste = JSON.parse(readFileSync(tasteFile, 'utf8')) as TvTasteProfileFile;
    const shows = snapshot.shows ?? [];
    const recent = recentTitles(historyFile, tvRecsConfig.recsRecentWindow);
    // T404: also exclude currently owner-ignored recommendations, not just historied ones.
    const alreadySuggested = [...new Set([
      ...allHistoryTitles(historyFile, tvRecsConfig.recsHistoryContext),
      ...ignoredSuggestionTitles(),
    ])];
    const limit = concurrency;
    ctx.log(`  Re-prompting ${BRANCHES.length} branch(es) (round ${round}, concurrency ${limit}), excluding ${exclude.length} already-collected/owned/considered title(s); ${alreadySuggested.length} already-suggested history title(s) in context…`);
    const pooled: RawSuggestion[] = [];
    await runBounded(BRANCHES, limit, async (spec) => {
      let more: RawSuggestion[];
      try {
        more = await collectBranchSuggestions(
          spec,
          { profile: taste.profile, shows, recent, alreadySuggested, sampleSize: tvRecsConfig.recsSampleSize, ask: tvRecsConfig.recsPerBranchAsk, exclude },
          run,
          tvRecsConfig.recsModel,
        );
      } catch (err) {
        ctx.log(`    • ${spec.id} (${spec.lens}) — failed: ${err instanceof Error ? err.message.split('\n')[0] : err}`, 'warn');
        return;
      }
      ctx.log(`    • ${spec.id} (${spec.lens}) → ${more.length} suggestion(s)`);
      if (more.length) pooled.push(...more);
    });
    return pooled;
  };
}

export async function runTvRecMerge(ctx: JobContext, opts: MergeOpts = {}): Promise<void> {
  ensureDirs();
  const search = opts.searchTv ?? defaultSearchTv;
  const snapshotFile = opts.snapshotFile ?? tvRecsConfig.snapshotOut;
  const tasteFile = opts.tasteFile ?? tvRecsConfig.tasteOut;
  const historyFile = opts.historyFile ?? tvRecsConfig.recsHistoryOut;
  const recsDir = opts.recsDir ?? tvRecsConfig.recsDir;
  const recsOut = opts.recsOut ?? tvRecsConfig.recsOut;
  const now = opts.now ?? new Date();
  const params: MergeParams = {
    minRating: opts.minRating ?? tvRecsConfig.recsMinRating,
    minVotes: opts.minVotes ?? tvRecsConfig.recsMinVotes,
    target: opts.target ?? tvRecsConfig.recsTarget,
    genreCap: opts.genreCap ?? tvRecsConfig.recsGenreCap,
    topUpRounds: opts.topUpRounds ?? tvRecsConfig.recsTopUpRounds,
  };

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('tv-rec-merge starting');
  if (!existsSync(snapshotFile)) {
    throw new Error(`snapshot.json not found — run tv-snapshot first (${snapshotFile}).`);
  }
  const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8')) as TvSnapshotFile;
  const owned = buildOwnedSet(snapshot.shows ?? []);
  ctx.log(`Owned set size ${owned.size}. Target ≥${params.target}; quality bar rating ≥${params.minRating} with ≥${params.minVotes} votes.`);

  ctx.log('Pooling branch suggestions…');
  const pooled = poolBranchSuggestions(recsDir, ctx);
  const unique = dedupeRawByTitleYear(pooled);
  ctx.log(`Pooled ${pooled.length} raw suggestion(s) → ${unique.length} after title/year dedup.`);
  if (unique.length < pooled.length) {
    const survivingSet = new Set<RawSuggestion>(unique);
    const dupes = pooled.filter((s) => !survivingSet.has(s));
    for (const s of dupes) ctx.log(`  ⟳ "${s.title}"${s.year ? ` (${s.year})` : ''} [${s.lens}] — duplicate, kept first occurrence.`);
  }

  const byTmdb = new Map<number, Recommendation>();
  const counters: VerifyCounters = {
    searches: 0, dropHallucinated: 0, dropOwned: 0, dropAlready: 0, dropLowQuality: 0, quotaHit: false,
    searchFailed: 0,
  };
  const seen = new Set<string>();
  const considered: string[] = [];
  for (const s of unique) { seen.add(rawKey(s)); considered.push(displayTitle(s)); }
  // T404: also exclude currently owner-ignored recommendations from the top-up prompt,
  // even if they were never appended to the history file (a pre-notify ignore).
  for (const title of ignoredSuggestionTitles()) {
    if (!considered.includes(title)) considered.push(title);
  }

  ctx.progress(20, `verifying ${unique.length}`);
  await verifyInto(unique, byTmdb, owned, search, ctx, params, counters);

  let balanced = balanceByGenre([...byTmdb.values()], { cap: params.genreCap, target: params.target });

  const topUp = opts.topUp
    ?? buildDefaultTopUp(snapshot, tasteFile, historyFile, opts.runClaude ?? runClaude, ctx, opts.topUpConcurrency ?? tvRecsConfig.recsTopUpConcurrency);
  let round = 0;
  let topUpStopReason = '';
  while (!counters.quotaHit && balanced.length < params.target && round < params.topUpRounds) {
    round++;
    ctx.log(`Top-up round ${round}/${params.topUpRounds}: have ${balanced.length}/${params.target} — re-prompting branches for more…`);
    let more: RawSuggestion[];
    try {
      more = await topUp(considered, round);
    } catch (err) {
      ctx.log(`  ✗ top-up round ${round} failed (${err instanceof Error ? err.message.split('\n')[0] : err}) — stopping.`, 'warn');
      topUpStopReason = `error in round ${round}`;
      break;
    }
    const fresh: RawSuggestion[] = [];
    for (const s of dedupeRawByTitleYear(more)) {
      const k = rawKey(s);
      if (seen.has(k)) {
        ctx.log(`  ⟳ "${displayTitle(s)}" [${s.lens}] — already seen this run — skipped.`);
        continue;
      }
      seen.add(k);
      considered.push(displayTitle(s));
      fresh.push(s);
    }
    ctx.log(`  • round ${round}: ${more.length} returned → ${fresh.length} new to verify.`);
    if (!fresh.length) {
      topUpStopReason = `round ${round}: +0 new — stopping early`;
      ctx.log(`  • ${topUpStopReason}.`);
      break;
    }
    const beforeVerify = byTmdb.size;
    await verifyInto(fresh, byTmdb, owned, search, ctx, params, counters);
    const added = byTmdb.size - beforeVerify;
    balanced = balanceByGenre([...byTmdb.values()], { cap: params.genreCap, target: params.target });
    ctx.log(`  • round ${round}: +${added} verified → ${balanced.length}/${params.target}.`);
    ctx.progress(20 + (round / params.topUpRounds) * 70, `top-up ${round}: ${balanced.length}/${params.target}`);
  }
  if (!topUpStopReason && round > 0) {
    if (counters.quotaHit) topUpStopReason = 'TMDB quota hit';
    else if (balanced.length >= params.target) topUpStopReason = `target ${params.target} reached`;
    else topUpStopReason = `max rounds (${params.topUpRounds}) reached`;
    if (round > 0) ctx.log(`  • top-up stopped: ${topUpStopReason}.`);
  }

  const verified = [...byTmdb.values()];
  const out: RecommendationsFile = { generatedAt: now.toISOString(), pooled: pooled.length, recommendations: balanced };
  writeJsonFile(recsOut, out);

  ctx.progress(100, `${balanced.length} recommendation(s)`);
  ctx.log('');
  ctx.log('═══════════════ TV-REC-MERGE SUMMARY ═══════════════');
  ctx.log(`Pooled ${pooled.length} · considered ${considered.length} · TMDB searches ${counters.searches}${counters.quotaHit ? ' (stopped on quota)' : ''} · top-up rounds ${round}${topUpStopReason ? ` (${topUpStopReason})` : ''}.`);
  ctx.log(`Dropped: ${counters.dropHallucinated} hallucinated · ${counters.dropOwned} owned · ${counters.dropAlready} already-recommended · ${counters.dropLowQuality} below quality bar.`);
  ctx.log(`Verified novel: ${verified.length} → balanced to ${balanced.length} (cap ${params.genreCap}/genre, target ${params.target}).`);
  if (balanced.length < params.target) {
    ctx.log(`⚠ Only ${balanced.length}/${params.target} quality picks after ${round} top-up round(s) — outputting what we have.`, 'warn');
  }
  if (verified.length > balanced.length) {
    const balancedSet = new Set(balanced.map((r) => r.tmdbId));
    const capped = verified.filter((r) => !balancedSet.has(r.tmdbId));
    for (const r of capped) ctx.log(`  ⊘ genre-capped: "${r.title}"${r.year ? ` (${r.year})` : ''} [${r.genre}] — exceeded cap of ${params.genreCap}/genre.`);
  }
  for (const r of balanced) ctx.log(`  • [${r.genre}] ${r.title}${r.year ? ` (${r.year})` : ''} — ${r.reason} (${r.lens})`);
  ctx.log(`Wrote ${recsOut}`);
  ctx.log('════════════════════════════════════════════════════');

  if (counters.searchFailed > 0) {
    throw new Error(`TMDB search failed for ${counters.searchFailed} suggestion(s) this run — see warn logs above for titles.`);
  }
}
