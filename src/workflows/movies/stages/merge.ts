import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { QuotaExceededError, callService } from '../../../core/services.js';
import type { JobContext } from '../../../core/types.js';
import { tmdbGet } from '../../../core/plex-client.js';
import { moviesConfig } from '../config.js';
import { ensureDirs, writeJsonFile } from '../lib.js';
import { buildOwnedSet } from '../movies.js';
import {
  RECS_JOB,
  balanceByGenre,
  dedupeRawByTitleYear,
  genreNameFromIds,
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
  MovieSnapshotFile,
  RawSuggestion,
  Recommendation,
  RecommendationsFile,
  TasteProfileFile,
  TmdbSearchResponse,
  TmdbSearchResult,
} from '../types.js';

/** TMDB title search (injectable for tests). Returns the best match or null. */
export type SearchMovieFn = (title: string, year: number | null) => Promise<TmdbSearchResult | null>;

/**
 * Re-prompt the branches for ADDITIONAL suggestions (T162 top-up). Given the
 * titles already collected/owned/considered this run, returns fresh raw
 * suggestions to verify+merge. Injectable for tests; the default fans out over
 * all 8 branch specs in-memory (no file I/O).
 */
export type TopUpFn = (exclude: string[], round: number) => Promise<RawSuggestion[]>;

/**
 * Run `fn` over `items` with at most `limit` concurrent executions at any time.
 * Results are collected in completion order (attributed inside `fn` via logging).
 */
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

const defaultSearchMovie: SearchMovieFn = (title, year) =>
  callService(
    'tmdb',
    async () => {
      const params = new URLSearchParams({ query: title, include_adult: 'false' });
      if (year != null) params.set('year', String(year));
      const resp = await tmdbGet<TmdbSearchResponse>(`/search/movie?${params.toString()}`);
      return resp.results?.[0] ?? null;
    },
    { cacheKey: `tmdb:search:movie:${title}${year != null ? `:${year}` : ''}` },
  );

export interface MergeOpts {
  searchMovie?: SearchMovieFn;
  /** Inject the top-up source (tests). Defaults to fanning out over the branches. */
  topUp?: TopUpFn;
  /** Inject the Claude runner the default top-up uses (tests). */
  runClaude?: RunClaudeFn;
  snapshotFile?: string;
  tasteFile?: string;
  historyFile?: string;
  recsDir?: string;
  recsOut?: string;
  now?: Date;
  // ── Threshold/target overrides (default from moviesConfig; tests pass these) ──
  minRating?: number;
  minVotes?: number;
  target?: number;
  genreCap?: number;
  topUpRounds?: number;
  /** Max concurrent branch re-prompts per top-up round (tests inject this to assert bounds). */
  topUpConcurrency?: number;
}

/** A display label for a suggestion, used in the top-up exclude list + dedup. */
function displayTitle(s: RawSuggestion): string {
  return `${s.title}${s.year ? ` (${s.year})` : ''}`;
}

/** The cross-round dedup key for a raw suggestion (loose title + year). */
function rawKey(s: RawSuggestion): string {
  return `${normTitle(s.title)}::${s.year ?? ''}`;
}

/** Mutable counters threaded through every verify pass (initial + top-up rounds). */
interface VerifyCounters {
  searches: number;
  dropHallucinated: number;
  dropOwned: number;
  dropAlready: number;
  dropLowQuality: number;
  quotaHit: boolean;
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

/** Thresholds + target resolved once per run (config defaults, opts override). */
interface MergeParams {
  minRating: number;
  minVotes: number;
  target: number;
  genreCap: number;
  topUpRounds: number;
}

/**
 * Verify a batch of (already cross-round-deduped) raw suggestions and merge the
 * survivors into `byTmdb`. CODE enforces correctness so the LLM can't invent or
 * re-suggest: each suggestion must TMDB-resolve to a REAL id → NOT be owned →
 * NOT already recommended/ignored (the `movie-recs` ledger) → clear the QUALITY
 * bar (TMDB rating ≥ minRating AND vote_count ≥ minVotes, T162). Dedupes across
 * branches by resolved tmdb id (merging lenses). Mutates `byTmdb` + `counters`;
 * stops early (setting `counters.quotaHit`) when TMDB's quota is reached.
 */
async function verifyInto(
  batch: RawSuggestion[],
  byTmdb: Map<number, Recommendation>,
  owned: Set<number>,
  search: SearchMovieFn,
  ctx: JobContext,
  params: MergeParams,
  counters: VerifyCounters,
): Promise<void> {
  for (const s of batch) {
    let result: TmdbSearchResult | null;
    try {
      result = await search(s.title, s.year);
      counters.searches++;
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        ctx.log(`tmdb ${err.window} cap reached (${err.used}/${err.cap}) — stopping verification gracefully.`, 'warn');
        counters.quotaHit = true;
        return;
      }
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
    byTmdb.set(tmdbId, {
      tmdbId,
      title: result.title ?? s.title,
      year: result.release_date ? Number(result.release_date.slice(0, 4)) || s.year : s.year,
      reason: s.reason,
      lens: s.lens,
      genre: genreNameFromIds(result.genre_ids),
      tmdbRating: rating,
    });
  }
}

/**
 * The default top-up source (T162): fan out over all 8 branch specs IN-MEMORY
 * (no file I/O), re-prompting each Claude branch for ADDITIONAL well-regarded
 * films while excluding everything already collected/considered this run. Built
 * lazily so a run that never goes under target loads no taste profile.
 */
function buildDefaultTopUp(
  snapshot: MovieSnapshotFile,
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
    const taste = JSON.parse(readFileSync(tasteFile, 'utf8')) as TasteProfileFile;
    const movies = snapshot.movies ?? [];
    const recent = recentTitles(historyFile, moviesConfig.recsRecentWindow);
    // T183: full bounded history so top-up branches also avoid re-suggesting previously-recommended films.
    // T404: also exclude currently owner-ignored recommendations, not just historied ones.
    const alreadySuggested = [...new Set([
      ...allHistoryTitles(historyFile, moviesConfig.recsHistoryContext),
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
          { profile: taste.profile, movies, recent, alreadySuggested, sampleSize: moviesConfig.recsSampleSize, ask: moviesConfig.recsPerBranchAsk, exclude },
          run,
          moviesConfig.recsModel,
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

/**
 * Merge stage — pools all branches' raw suggestions, verifies+dedupes+quality-
 * filters them into the final balanced list. If fewer than the TARGET survive
 * (T162: ≥15 well-rated, un-owned, never-before-recommended, genre-balanced
 * picks), runs a BOUNDED top-up loop: re-prompt the branches for more, verify +
 * merge, repeat up to `topUpRounds` rounds or until the target is reached / no
 * new suggestions arrive. Writes data/out/recommendations.json. Resilient: per-
 * item search failures are skipped and a TMDB quota stops it gracefully — it
 * always writes a (possibly short) list and succeeds, so the notify stage runs.
 */
export async function runMerge(ctx: JobContext, opts: MergeOpts = {}): Promise<void> {
  ensureDirs();
  const search = opts.searchMovie ?? defaultSearchMovie;
  const snapshotFile = opts.snapshotFile ?? moviesConfig.snapshotOut;
  const tasteFile = opts.tasteFile ?? moviesConfig.tasteOut;
  const historyFile = opts.historyFile ?? moviesConfig.recsHistoryOut;
  const recsDir = opts.recsDir ?? moviesConfig.recsDir;
  const recsOut = opts.recsOut ?? moviesConfig.recsOut;
  const now = opts.now ?? new Date();
  const params: MergeParams = {
    minRating: opts.minRating ?? moviesConfig.recsMinRating,
    minVotes: opts.minVotes ?? moviesConfig.recsMinVotes,
    target: opts.target ?? moviesConfig.recsTarget,
    genreCap: opts.genreCap ?? moviesConfig.recsGenreCap,
    topUpRounds: opts.topUpRounds ?? moviesConfig.recsTopUpRounds,
  };

  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('rec-merge starting');
  if (!existsSync(snapshotFile)) {
    throw new Error(`snapshot.json not found — run movie-snapshot first (${snapshotFile}).`);
  }
  const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8')) as MovieSnapshotFile;
  const owned = buildOwnedSet(snapshot.movies ?? []);
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
  };
  // Every (loose) title key we've already considered — across the pool AND every
  // top-up round — so the top-up never re-asks for or re-verifies a known title.
  const seen = new Set<string>();
  const considered: string[] = []; // display labels handed to the branches as exclusions
  for (const s of unique) { seen.add(rawKey(s)); considered.push(displayTitle(s)); }
  // T404: also exclude currently owner-ignored recommendations from the top-up prompt,
  // even if they were never appended to the history file (a pre-notify ignore).
  for (const title of ignoredSuggestionTitles()) {
    if (!considered.includes(title)) considered.push(title);
  }

  ctx.progress(20, `verifying ${unique.length}`);
  await verifyInto(unique, byTmdb, owned, search, ctx, params, counters);

  let balanced = balanceByGenre([...byTmdb.values()], { cap: params.genreCap, target: params.target });

  // ── Bounded top-up loop (T162): re-prompt the branches until we hit the target. ──
  const topUp = opts.topUp
    ?? buildDefaultTopUp(snapshot, tasteFile, historyFile, opts.runClaude ?? runClaude, ctx, opts.topUpConcurrency ?? moviesConfig.recsTopUpConcurrency);
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
    // Keep only genuinely-new titles (not already pooled or seen in a prior round).
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
  ctx.log('═══════════════ REC-MERGE SUMMARY ═══════════════');
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
  ctx.log('══════════════════════════════════════════════════');
}
