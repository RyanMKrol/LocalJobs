// The 8 recommender branch specs (T109 design): 3 stratified-random serendipity
// branches + 5 targeted branches (2 depth: auteur-completion, top-genre-canon;
// 3 breadth: thin-genre round-out, older-era classics, world cinema). Each builds
// a prompt from the taste profile + a STRATIFIED (balanced) library sample and
// asks Claude for ~5 diverse, un-owned films. Pure prompt construction — no I/O.
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
  /** Recent recommendation titles to steer the model away from repeats. */
  recent: string[];
  /** Owned-library sample size to show (stratified). */
  sampleSize: number;
  /** How many films to ask Claude for (T162 — larger ask gives headroom). */
  ask: number;
  /** Extra titles to exclude (T162 top-up: everything already collected this run). */
  exclude?: string[];
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
    '- Recommend films I do NOT already own (none from the owned list) and NONE from the "recently recommended" or "already considered" lists.',
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

function ownedBlock(ctx: BranchContext, seed: number): string {
  const sample = stratifiedSample(ctx.movies, { keyFn: primaryGenre, target: ctx.sampleSize, seed });
  return `Films I already own (a balanced sample of my library):\n${fmtMovies(sample)}`;
}

function recentBlock(ctx: BranchContext): string {
  if (!ctx.recent.length) return '';
  return `\n\nRecently recommended to me (do NOT repeat these):\n${ctx.recent.map((t) => `- ${t}`).join('\n')}`;
}

/** T162 top-up: titles already collected/considered this run, to avoid repeats. */
function excludeBlock(ctx: BranchContext): string {
  if (!ctx.exclude?.length) return '';
  return `\n\nAlready considered this round (do NOT suggest any of these again):\n${ctx.exclude.map((t) => `- ${t}`).join('\n')}`;
}

function topGenresLine(profile: TasteProfile, n = 5): string {
  return topGenres(profile, n).map(([g, c]) => `${g} (${c})`).join(', ');
}

/** A few owned sample titles in a given genre (for canon/thin-genre context). */
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
      return [
        `You are a film curator helping me discover new movies. Based on the taste shown by the films I own, recommend films I would enjoy that I do not already own. Lean towards serendipity and variety, not the obvious next pick.`,
        '',
        ownedBlock(ctx, 1000 + n), // distinct seed per random branch → divergent slices
        recentBlock(ctx),
        excludeBlock(ctx),
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
    return [
      'I collect certain directors heavily. Recommend acclaimed or notable films BY THESE DIRECTORS that I likely do not own yet — deepen my collection of auteurs I already love.',
      '',
      `Directors I own at least 3 films by:\n${dirLines}`,
      '',
      ownedBlock(ctx, 2001),
      recentBlock(ctx),
      excludeBlock(ctx),
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
    const sampleLines = tg
      .map(([g]) => `${g}: ${titlesInGenre(ctx.movies, g, 4).map((m) => m.title).join(', ')}`)
      .join('\n');
    return [
      `My strongest genres are: ${topGenresLine(ctx.profile, 5)}. Recommend CANONICAL, acclaimed, or landmark films IN THOSE GENRES that I appear to have missed — blind spots in my own strengths.`,
      '',
      `Sample of what I own in those genres:\n${sampleLines}`,
      '',
      ownedBlock(ctx, 2002),
      recentBlock(ctx),
      excludeBlock(ctx),
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
    return [
      `I own very few films in some genres: ${thinLine}. Recommend acclaimed films in THOSE thin genres to broaden my library — do NOT amplify my dominant genres.`,
      '',
      ownedBlock(ctx, 2003),
      recentBlock(ctx),
      excludeBlock(ctx),
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
    return [
      `My library skews modern. Here is my by-decade count: ${decades || '(unknown)'}. Recommend acclaimed PRE-1980 classics — foundational films from the eras I under-own (silent era through the 1970s).`,
      '',
      ownedBlock(ctx, 2004),
      recentBlock(ctx),
      excludeBlock(ctx),
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
    return [
      `My library is dominated by these countries: ${countries || '(unknown)'} — mostly Anglophone. Recommend acclaimed NON-ENGLISH-LANGUAGE / world-cinema films I likely do not own, broadening beyond my Anglophone bias.`,
      '',
      ownedBlock(ctx, 2005),
      recentBlock(ctx),
      excludeBlock(ctx),
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
