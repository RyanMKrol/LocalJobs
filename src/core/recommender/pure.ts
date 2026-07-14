// Pure recommendation-layer helpers (no I/O) — the load-bearing rules shared by
// every recommender domain: the STRATIFIED (balanced, not proportional) library
// sampler, the per-genre output balancer, cross-branch dedup, and taste-profile
// slicing. Extracted verbatim (T561) from the byte-identical movies/tv-recs
// copies — unit-tested in pure.test.ts.
import type { RawSuggestion, Recommendation } from './types.js';

/** Ledger key for one recommendation: its tmdb id, as a string. */
export function recKey(tmdbId: number): string {
  return String(tmdbId);
}

// ── Deterministic seeded RNG (so branches diverge by seed AND tests are stable) ──

/** mulberry32 — a tiny deterministic PRNG seeded by an integer. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic Fisher–Yates shuffle (does not mutate the input). */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  const rnd = mulberry32(seed || 1);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** An item's primary genre for stratification (first genre, else "Unknown"). */
export function primaryGenre(m: { genres: string[] }): string {
  return m.genres[0] ?? 'Unknown';
}

/**
 * STRATIFIED sampling — sample roughly EQUAL counts across strata, NOT
 * proportional, so a dominant genre (e.g. 500 horror) does not drown out a thin
 * one (100 kids). Groups by `keyFn`, seeded-shuffles each group + the stratum
 * order (so different seeds diverge), then round-robins one item per stratum per
 * pass until `target` is reached or every group is exhausted. A 500/100 split
 * with a small target yields a ~balanced (≈50/50) sample, not 83/17.
 */
export function stratifiedSample<T>(
  items: T[],
  opts: { keyFn: (t: T) => string; target: number; seed: number },
): T[] {
  const { keyFn, target, seed } = opts;
  if (target <= 0 || items.length === 0) return [];
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = keyFn(it);
    const g = groups.get(k) ?? [];
    g.push(it);
    groups.set(k, g);
  }
  const strata = seededShuffle([...groups.keys()], seed);
  const pools = new Map<string, T[]>();
  strata.forEach((k, i) => pools.set(k, seededShuffle(groups.get(k) as T[], seed + i + 1)));

  const out: T[] = [];
  let progressed = true;
  while (out.length < target && progressed) {
    progressed = false;
    for (const k of strata) {
      if (out.length >= target) break;
      const g = pools.get(k) as T[];
      if (g.length) {
        out.push(g.shift() as T);
        progressed = true;
      }
    }
  }
  return out;
}

// ── Taste-profile slicing (what the branch prompts target) ──

/** The N genres the owner owns the MOST of (their strengths), `[genre, count]`. */
export function topGenres(profile: { genres: Record<string, number> }, n: number): [string, number][] {
  return Object.entries(profile.genres).sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** Genres the owner owns FEW of (their breadth gaps) — the bottom N by count,
 *  excluding ones they own none of (a thin genre is owned-but-sparse). */
export function thinGenres(profile: { genres: Record<string, number> }, n: number): [string, number][] {
  return Object.entries(profile.genres)
    .filter(([, c]) => c > 0)
    .sort((a, b) => a[1] - b[1])
    .slice(0, n);
}

/**
 * Entries owned/owned-by AT LEAST `min` times, sorted by count descending — the
 * shared shape behind movies' `directorsOwnedAtLeast(profile.directors, min)`
 * and tv-recs' `creatorsOwnedAtLeast(profile.roles, min)` (each a thin wrapper
 * over this on their own per-key `Record<string, number>`).
 */
export function ownedAtLeast(counts: Record<string, number>, min: number): [string, number][] {
  return Object.entries(counts)
    .filter(([, c]) => c >= min)
    .sort((a, b) => b[1] - a[1]);
}

// ── Cross-branch dedup + output balancing ──

/** Normalize a title for loose equality (lowercase, strip non-alphanumerics). */
export function normTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Pre-search dedup of raw suggestions by (normalized title, year) so the same
 * item recommended by several branches costs ONE TMDB lookup. Keeps the first
 * occurrence (its lens). Blank-title suggestions are dropped.
 */
export function dedupeRawByTitleYear(raw: RawSuggestion[]): RawSuggestion[] {
  const seen = new Set<string>();
  const out: RawSuggestion[] = [];
  for (const s of raw) {
    const t = (s.title ?? '').trim();
    if (!t) continue;
    const k = `${normTitle(t)}::${s.year ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * Balance the final output so the digest isn't one flavour: at most `cap` per
 * genre, up to `target` total, round-robined across genres (so each genre gets a
 * fair share before any genre reaches its cap). Stable within a genre.
 */
export function balanceByGenre<T extends { genre: string }>(
  recs: T[],
  opts: { cap: number; target: number },
): T[] {
  const { cap, target } = opts;
  const byGenre = new Map<string, T[]>();
  const order: string[] = [];
  for (const r of recs) {
    if (!byGenre.has(r.genre)) { byGenre.set(r.genre, []); order.push(r.genre); }
    (byGenre.get(r.genre) as T[]).push(r);
  }
  const taken = new Map<string, number>();
  const out: T[] = [];
  let progressed = true;
  while (out.length < target && progressed) {
    progressed = false;
    for (const g of order) {
      if (out.length >= target) break;
      const pool = byGenre.get(g) as T[];
      const used = taken.get(g) ?? 0;
      if (used < cap && used < pool.length) {
        out.push(pool[used]);
        taken.set(g, used + 1);
        progressed = true;
      }
    }
  }
  return out;
}

/** Merge a duplicate recommendation's lens into an existing one (dedup join). */
export function mergeLens(existing: Recommendation, lens: string): void {
  const lenses = existing.lens.split(', ');
  if (!lenses.includes(lens)) existing.lens = [...lenses, lens].join(', ');
}

/** Build the owned tmdbId set from any array of items carrying a nullable tmdbId. */
export function buildOwnedSet(items: { tmdbId: number | null }[]): Set<number> {
  const s = new Set<number>();
  for (const it of items) if (it.tmdbId != null) s.add(it.tmdbId);
  return s;
}
