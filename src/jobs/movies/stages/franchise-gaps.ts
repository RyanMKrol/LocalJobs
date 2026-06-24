import { existsSync, readFileSync } from 'node:fs';
import { QuotaExceededError, callService } from '../../../core/services.js';
import type { JobContext } from '../../../core/types.js';
import { tmdbGet } from '../../plex/client.js';
import { moviesConfig } from '../config.js';
import { ensureDirs, writeJsonFile } from '../lib.js';
import { buildOwnedSet, collectionGaps } from '../movies.js';
import type {
  FranchiseGap,
  FranchiseGapsFile,
  MovieSnapshotFile,
  TmdbCollectionDetail,
  TmdbMovieDetail,
} from '../types.js';

/** Fetch one TMDB `/movie/{id}` detail (injectable for tests). */
export type MovieFetch = (tmdbId: number) => Promise<TmdbMovieDetail>;
/** Fetch one TMDB `/collection/{id}` detail (injectable for tests). */
export type CollectionFetch = (collectionId: number) => Promise<TmdbCollectionDetail>;

export interface FranchiseGapsOpts {
  /** Override "now" (tests). Defaults to a fresh Date. */
  now?: Date;
  /** Override the snapshot input path (tests). */
  snapshotFile?: string;
  /** Override the gaps output path (tests). */
  gapsFile?: string;
  /** Override the /movie fetch (tests). Defaults to the rate-limited tmdb service. */
  fetchMovie?: MovieFetch;
  /** Override the /collection fetch (tests). Defaults to the rate-limited tmdb service. */
  fetchCollection?: CollectionFetch;
}

const defaultMovieFetch: MovieFetch = (id) =>
  callService('tmdb', () => tmdbGet<TmdbMovieDetail>(`/movie/${id}`));
const defaultCollectionFetch: CollectionFetch = (id) =>
  callService('tmdb', () => tmdbGet<TmdbCollectionDetail>(`/collection/${id}`));

/**
 * Stage 2 — the DETERMINISTIC franchise-gap detector via the TMDB Collections
 * API. For each owned movie with a tmdbId: GET `/movie/{id}` → its
 * `belongs_to_collection`. For each DISTINCT collection: GET `/collection/{id}`
 * → `parts[]`; a gap is any RELEASED part whose tmdb id is NOT owned. Dedupes
 * collection fetches (each fetched once even if several members are owned). NO
 * quality filter, NO skip heuristics — every factual gap is surfaced; the TMDB
 * rating rides along for context only. TMDB calls route through the shared
 * rate-limited `tmdb` service. RE-COMPUTES FRESH every run.
 */
export async function runFranchiseGaps(ctx: JobContext, opts: FranchiseGapsOpts = {}): Promise<void> {
  ensureDirs();
  const now = opts.now ?? new Date();
  const snapshotFile = opts.snapshotFile ?? moviesConfig.snapshotOut;
  const gapsFile = opts.gapsFile ?? moviesConfig.gapsOut;
  const fetchMovie = opts.fetchMovie ?? defaultMovieFetch;
  const fetchCollection = opts.fetchCollection ?? defaultCollectionFetch;
  ctx.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  ctx.log('franchise-gaps starting');
  if (!existsSync(snapshotFile)) {
    throw new Error(`snapshot.json not found — run movie-snapshot first (${snapshotFile}).`);
  }
  const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8')) as MovieSnapshotFile;
  const movies = snapshot.movies ?? [];
  const owned = buildOwnedSet(movies);
  const withTmdb = movies.filter((m) => m.tmdbId != null);
  ctx.log(`Loaded ${movies.length} movies (${withTmdb.length} with a tmdbId; owned set size ${owned.size}).`);

  let tmdbCalls = 0;
  let quotaHit = false;

  // ── Pass 1: discover the DISTINCT collection ids the library belongs to. ──
  ctx.log('Pass 1/2 — resolving each owned movie\'s collection (TMDB /movie/{id})…');
  const collectionIds = new Map<number, string>(); // id → name (best-effort)
  for (let i = 0; i < withTmdb.length; i++) {
    const m = withTmdb[i];
    ctx.progress((i / Math.max(withTmdb.length, 1)) * 60, `resolved ${i}/${withTmdb.length} movies`);
    try {
      const detail = await fetchMovie(m.tmdbId as number);
      tmdbCalls++;
      const coll = detail.belongs_to_collection;
      if (coll && typeof coll.id === 'number' && !collectionIds.has(coll.id)) {
        collectionIds.set(coll.id, coll.name ?? `Collection ${coll.id}`);
        ctx.log(`  • "${m.title}" → collection "${coll.name}" (#${coll.id})`);
      }
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        ctx.log(`tmdb ${err.window} cap reached (${err.used}/${err.cap}) — stopping gracefully; next run resumes.`, 'warn');
        quotaHit = true;
        break;
      }
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      ctx.log(`  ✗ "${m.title}" (tmdb=${m.tmdbId}) — ${msg}`, 'warn');
    }
  }
  ctx.log(`Distinct collections discovered: ${collectionIds.size}.`);

  // ── Pass 2: for each distinct collection, find released-not-owned parts. ──
  const gaps: FranchiseGap[] = [];
  const ids = [...collectionIds.keys()];
  if (!quotaHit) {
    ctx.log('Pass 2/2 — fetching each collection\'s parts (TMDB /collection/{id})…');
    for (let i = 0; i < ids.length; i++) {
      const cid = ids[i];
      ctx.progress(60 + (i / Math.max(ids.length, 1)) * 40, `checked ${i}/${ids.length} collections`);
      try {
        const detail = await fetchCollection(cid);
        tmdbCalls++;
        const found = collectionGaps(detail, owned, now);
        if (found.length) {
          gaps.push(...found);
          ctx.log(`  ✓ "${detail.name ?? collectionIds.get(cid)}" — missing ${found.length}: ${found.map((g) => g.title).join(', ')}`);
        }
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          ctx.log(`tmdb ${err.window} cap reached (${err.used}/${err.cap}) — stopping gracefully; next run resumes.`, 'warn');
          break;
        }
        const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
        ctx.log(`  ✗ collection #${cid} — ${msg}`, 'warn');
      }
    }
  }

  // Sort gaps for a stable, readable artifact (by collection, then year, then title).
  gaps.sort((a, b) =>
    a.collectionName.localeCompare(b.collectionName) ||
    (a.year ?? 0) - (b.year ?? 0) ||
    a.title.localeCompare(b.title));

  const out: FranchiseGapsFile = {
    generatedAt: new Date().toISOString(),
    collectionsChecked: collectionIds.size,
    gaps,
  };
  writeJsonFile(gapsFile, out);

  ctx.progress(100, `${gaps.length} franchise gaps`);
  ctx.log('');
  ctx.log('═══════════════ FRANCHISE-GAPS SUMMARY ═══════════════');
  ctx.log(`Owned movies with a tmdbId: ${withTmdb.length} · TMDB calls: ${tmdbCalls}.`);
  ctx.log(`Distinct collections: ${collectionIds.size} · franchise gaps found: ${gaps.length}.`);
  for (const g of gaps.slice(0, 20)) {
    ctx.log(`  • ${g.collectionName}: ${g.title}${g.year ? ` (${g.year})` : ''} — TMDB ${g.tmdbRating ?? '—'}`);
  }
  if (gaps.length > 20) ctx.log(`  … and ${gaps.length - 20} more.`);
  ctx.log(`Wrote ${gapsFile}`);
  ctx.log('═════════════════════════════════════════════════════');
}
