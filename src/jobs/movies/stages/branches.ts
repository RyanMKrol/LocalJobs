// The 8 recommender branch specs (T109 design): 3 stratified-random serendipity
// branches + 5 targeted branches (2 depth: auteur-completion, top-genre-canon;
// 3 breadth: thin-genre round-out, older-era classics, world cinema). Each builds
// a prompt from the taste profile + a TARGETED (lens-specific) subset of owned
// films and asks Claude for ~5 diverse, un-owned films. Pure prompt construction — no I/O.
//
// T183: per-branch owned-awareness — each branch gets a LENS-TARGETED subset of owned
// titles (not the full library) plus the full already-suggested history so it avoids
// re-suggesting owned or previously-recommended films (no obscurity bias: missing
// canonical films still surface; the deterministic merge filter stays authoritative).
import {
  directorsOwnedAtLeast,
  primaryGenre,
  stratifiedSample,
  thinGenres,
  topGenres,
} from '../recs.js';
import type { PlexMovie, TasteProfile } from '../types.js';

export type BranchKind = 'random' | 'targeted';

export interface BranchContext {
  profile: TasteProfile;
  movies: PlexMovie[];
  /** Recent recommendation titles to steer the model away from repeats (legacy window). */
  recent: string[];
  /** Owned-library sample size to show (stratified; used by random branches). */
  sampleSize: number;
  /** How many films to ask Claude for (T162 — larger ask gives headroom). */
  ask: number;
  /** Extra titles to exclude (T162 top-up: everything already collected this run). */
  exclude?: string[];
  /**
   * Full already-recommended/ignored title list (T183): bounded to recsHistoryContext.
   * When present, replaces `recent` as the "do not re-suggest" context (broader).
   */
  alreadySuggested?: string[];
}

export interface BranchSpec {
  /** Job name (unique, stable DB key) AND the lens tag on its suggestions. */
  id: string;
  lens: string;
  kind: BranchKind;
  description: string;
  /**
   * Build the branch prompt, or return null to SKIP (e.g. auteur-completion when
   * no director qualifies) — a skipped branch writes empty suggestions and the
   * run continues.
   */
  build(ctx: BranchContext): string | null;
}

/**
 * The shared per-branch rules + JSON contract. The ASK count is parameterized
 * (T162) so the merge can request a larger batch (and re-prompt for more in a
 * top-up round) — favour well-regarded films so they survive the merge's quality
 * filter (TMDB rating ≥ ~7 with a meaningful vote count).
 */
function rules(ask: number): string {
  return [
    '',
    'Rules:',
    '- Recommend films I do NOT already own (none from my owned lists) and NONE from the "already recommended or considered" list.',
    '- Do NOT recommend sequels or other entries in franchises I am already collecting — straight standalone or new-to-me films only.',
    '- Favour DIVERSE picks (vary genre, era, country) — never return all-one-flavour.',
    '- Favour WELL-REGARDED, acclaimed films (these get filtered against a quality bar, so avoid obscure low-rated picks).',
    '- Give a concise one-line reason for each pick.',
    `Return ONLY a JSON object, no prose: {"recommendations":[{"title":"...","year":1999,"reason":"..."}]}. About ${ask} films.`,
  ].join('\n');
}

function fmtMovies(movies: PlexMovie[]): string {
  return movies.map((m) => `- ${m.title}${m.year ? ` (${m.year})` : ''}`).join('\n');
}

// ── Per-branch cap for lens-targeted owned subsets (bounded, not the full library) ──
// Each targeted branch filters the library to its relevant lens, then caps at this
// size (use sampleSize from ctx so it's configurable; these helpers take the cap).
const LENS_CAP_DEFAULT = 50;

/** Owned films by the given set of directors (bounded at cap). */
export function ownedByDirectors(movies: PlexMovie[], dirNames: string[], cap = LENS_CAP_DEFAULT): PlexMovie[] {
  const set = new Set(dirNames);
  return movies.filter((m) => m.directors.some((d) => set.has(d))).slice(0, cap);
}

/** Owned films that belong to any of the given genres (bounded at cap). */
export function ownedInGenres(movies: PlexMovie[], genres: string[], cap = LENS_CAP_DEFAULT): PlexMovie[] {
  const set = new Set(genres);
  return movies.filter((m) => m.genres.some((g) => set.has(g))).slice(0, cap);
}

/** Owned films released before `beforeYear` (bounded at cap). */
export function ownedPreYear(movies: PlexMovie[], beforeYear: number, cap = LENS_CAP_DEFAULT): PlexMovie[] {
  return movies.filter((m) => m.year != null && m.year < beforeYear).slice(0, cap);
}

/** Countries considered predominantly Anglophone for world-cinema filtering. */
export const ANGLOPHONE_COUNTRIES = new Set([
  'United States', 'United Kingdom', 'Australia', 'Canada', 'New Zealand', 'Ireland',
]);

/** Owned films with at least one non-Anglophone country (bounded at cap). */
export function ownedNonAnglophone(movies: PlexMovie[], cap = LENS_CAP_DEFAULT): PlexMovie[] {
  return movies.filter((m) => m.countries.some((c) => !ANGLOPHONE_COUNTRIES.has(c))).slice(0, cap);
}

/** Format a labelled owned-films block (omit entirely when the subset is empty). */
function lensOwnedBlock(label: string, movies: PlexMovie[]): string {
  if (!movies.length) return '';
  return `\n\n${label} (${movies.length} — do NOT re-suggest any of these):\n${fmtMovies(movies)}`;
}

/**
 * Combined "do not suggest" block: full already-recommended/ignored history
 * (T183 `alreadySuggested`, or `recent` as fallback) + T162 top-up exclude list.
 * Phrased as "avoid re-suggesting these specific titles", NOT "prefer obscure films".
 */
function avoidBlock(ctx: BranchContext): string {
  const base = ctx.alreadySuggested ?? ctx.recent;
  const all = [...base, ...(ctx.exclude ?? [])];
  const unique = [...new Set(all)];
  if (!unique.length) return '';
  return `\n\nAlready recommended to me or already considered this run — avoid re-suggesting any of these ${unique.length} specific titles:\n${unique.map((t) => `- ${t}`).join('\n')}`;
}

function topGenresLine(profile: TasteProfile, n = 5): string {
  return topGenres(profile, n).map(([g, c]) => `${g} (${c})`).join(', ');
}

/** A few owned sample titles in a given genre (for canon context). */
function titlesInGenre(movies: PlexMovie[], genre: string, n: number): PlexMovie[] {
  return movies.filter((m) => m.genres.includes(genre)).slice(0, n);
}

// ── The 3 stratified-random serendipity branches ──
function randomBranch(n: number): BranchSpec {
  return {
    id: `rec-random-${n}`,
    lens: 'serendipity',
    kind: 'random',
    description: `Stage: serendipity branch ${n} — recommends diverse films from a stratified-random slice of the owned library.`,
    build(ctx) {
      // Random branches use the stratified sample (balanced across genres) for owned context —
      // they have no narrow lens to filter by, so a representative sample is appropriate.
      const sample = stratifiedSample(ctx.movies, { keyFn: primaryGenre, target: ctx.sampleSize, seed: 1000 + n });
      return [
        `You are a film curator helping me discover new movies. Based on the taste shown by the films I own, recommend films I would enjoy that I do not already own. Lean towards serendipity and variety, not the obvious next pick.`,
        '',
        `Films I already own (a balanced sample of my library — ${sample.length} titles):\n${fmtMovies(sample)}`,
        avoidBlock(ctx),
        rules(ctx.ask),
      ].join('\n');
    },
  };
}

// ── Targeted branch 1 (depth): auteur completion ──
const auteurBranch: BranchSpec = {
  id: 'rec-auteur',
  lens: 'auteur-completion',
  kind: 'targeted',
  description: 'Stage: auteur-completion branch (depth) — acclaimed films by directors I already collect heavily.',
  build(ctx) {
    const dirs = directorsOwnedAtLeast(ctx.profile, 3).slice(0, 8);
    if (!dirs.length) return null; // nothing to complete → skip gracefully
    const dirLines = dirs.map(([d, c]) => `- ${d} (I own ${c})`).join('\n');
    // Lens-targeted owned subset: films by those specific directors only.
    const ownedByTheseDirs = ownedByDirectors(ctx.movies, dirs.map(([d]) => d), ctx.sampleSize);
    return [
      'I collect certain directors heavily. Recommend acclaimed or notable films BY THESE DIRECTORS that I likely do not own yet — deepen my collection of auteurs I already love.',
      '',
      `Directors I own at least 3 films by:\n${dirLines}`,
      lensOwnedBlock('Films I already own by these directors', ownedByTheseDirs),
      avoidBlock(ctx),
      rules(ctx.ask),
    ].join('\n');
  },
};

// ── Targeted branch 2 (depth): canon of top genres ──
const canonBranch: BranchSpec = {
  id: 'rec-canon',
  lens: 'top-genre-canon',
  kind: 'targeted',
  description: 'Stage: top-genre-canon branch (depth) — canonical films in my strongest genres I somehow missed.',
  build(ctx) {
    const tg = topGenres(ctx.profile, 4);
    if (!tg.length) return null;
    const genreNames = tg.map(([g]) => g);
    const sampleLines = tg
      .map(([g]) => `${g}: ${titlesInGenre(ctx.movies, g, 4).map((m) => m.title).join(', ')}`)
      .join('\n');
    // Lens-targeted owned subset: films in those top genres specifically.
    const ownedInTopGenres = ownedInGenres(ctx.movies, genreNames, ctx.sampleSize);
    return [
      `My strongest genres are: ${topGenresLine(ctx.profile, 5)}. Recommend CANONICAL, acclaimed, or landmark films IN THOSE GENRES that I appear to have missed — blind spots in my own strengths.`,
      '',
      `Sample of what I own in those genres:\n${sampleLines}`,
      lensOwnedBlock('Films I already own in my top genres', ownedInTopGenres),
      avoidBlock(ctx),
      rules(ctx.ask),
    ].join('\n');
  },
};

// ── Targeted branch 3 (breadth): thin-genre round-out ──
const thinGenreBranch: BranchSpec = {
  id: 'rec-thin-genre',
  lens: 'thin-genre',
  kind: 'targeted',
  description: 'Stage: thin-genre round-out branch (breadth) — acclaimed films in genres I own few of.',
  build(ctx) {
    const thin = thinGenres(ctx.profile, 5);
    if (!thin.length) return null;
    const thinLine = thin.map(([g, c]) => `${g} (only ${c})`).join(', ');
    // Lens-targeted owned subset: the thin-genre films I already have (few, but show them).
    const ownedInThinGenres = ownedInGenres(ctx.movies, thin.map(([g]) => g), ctx.sampleSize);
    return [
      `I own very few films in some genres: ${thinLine}. Recommend acclaimed films in THOSE thin genres to broaden my library — do NOT amplify my dominant genres.`,
      lensOwnedBlock('Films I already own in these thin genres', ownedInThinGenres),
      avoidBlock(ctx),
      rules(ctx.ask),
    ].join('\n');
  },
};

// ── Targeted branch 4 (breadth): older-era classics ──
const olderEraBranch: BranchSpec = {
  id: 'rec-older-era',
  lens: 'older-era',
  kind: 'targeted',
  description: 'Stage: older-era classics branch (breadth) — acclaimed pre-1980 films from eras I under-own.',
  build(ctx) {
    const decades = Object.entries(ctx.profile.decades)
      .filter(([d]) => d !== 'Unknown')
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([d, c]) => `${d}: ${c}`)
      .join(', ');
    // Lens-targeted owned subset: pre-1980 films I already own.
    const ownedOlder = ownedPreYear(ctx.movies, 1980, ctx.sampleSize);
    return [
      `My library skews modern. Here is my by-decade count: ${decades || '(unknown)'}. Recommend acclaimed PRE-1980 classics — foundational films from the eras I under-own (silent era through the 1970s).`,
      lensOwnedBlock('Pre-1980 films I already own', ownedOlder),
      avoidBlock(ctx),
      rules(ctx.ask),
    ].join('\n');
  },
};

// ── Targeted branch 5 (breadth): world cinema ──
const worldCinemaBranch: BranchSpec = {
  id: 'rec-world-cinema',
  lens: 'world-cinema',
  kind: 'targeted',
  description: 'Stage: world-cinema branch (breadth) — acclaimed non-English films I under-own.',
  build(ctx) {
    const countries = Object.entries(ctx.profile.countries)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([c, n]) => `${c} (${n})`)
      .join(', ');
    // Lens-targeted owned subset: non-Anglophone films I already own.
    const ownedForeign = ownedNonAnglophone(ctx.movies, ctx.sampleSize);
    return [
      `My library is dominated by these countries: ${countries || '(unknown)'} — mostly Anglophone. Recommend acclaimed NON-ENGLISH-LANGUAGE / world-cinema films I likely do not own, broadening beyond my Anglophone bias.`,
      lensOwnedBlock('Non-Anglophone films I already own', ownedForeign),
      avoidBlock(ctx),
      rules(ctx.ask),
    ].join('\n');
  },
};

/** All 8 branch specs in DAG order (3 random + 5 targeted). */
export const BRANCHES: BranchSpec[] = [
  randomBranch(1),
  randomBranch(2),
  randomBranch(3),
  auteurBranch,
  canonBranch,
  thinGenreBranch,
  olderEraBranch,
  worldCinemaBranch,
];

/** Look up a branch spec by its job id (for the thin per-branch job wrappers). */
export function branchById(id: string): BranchSpec {
  const spec = BRANCHES.find((b) => b.id === id);
  if (!spec) throw new Error(`unknown recommender branch: ${id}`);
  return spec;
}
