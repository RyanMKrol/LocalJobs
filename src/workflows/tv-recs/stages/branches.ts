// The 8 TV recommender branch specs: 3 stratified-random serendipity branches +
// 5 targeted branches (creator/showrunner-completion, top-genre-canon,
// thin-genre round-out, older-era classics, world/international TV).
// Pure prompt construction — no I/O. Mirrors src/workflows/movies/stages/branches.ts.
import {
  creatorsOwnedAtLeast,
  primaryGenre,
  stratifiedSample,
  thinGenres,
  topGenres,
} from '../recs.js';
import type { PlexShow, TvTasteProfile } from '../types.js';

export type BranchKind = 'random' | 'targeted';

export interface BranchContext {
  profile: TvTasteProfile;
  shows: PlexShow[];
  /** Recent recommendation titles to steer away from repeats. */
  recent: string[];
  /** Owned-library sample size shown to each branch. */
  sampleSize: number;
  /** How many shows to ask Claude for (headroom before dedup/quality filter). */
  ask: number;
  /** Extra titles to exclude (top-up: everything already collected this run). */
  exclude?: string[];
  /** Full already-recommended/ignored title list (bounded; replaces `recent` when present). */
  alreadySuggested?: string[];
}

export interface BranchSpec {
  /** Job name (unique, stable DB key) AND the lens tag on its suggestions. */
  id: string;
  lens: string;
  kind: BranchKind;
  description: string;
  /**
   * Build the branch prompt, or return null to SKIP (e.g. creator-completion when
   * no creator qualifies) — a skipped branch writes empty suggestions and continues.
   */
  build(ctx: BranchContext): string | null;
}

function rules(ask: number): string {
  return [
    '',
    'Rules:',
    '- Recommend TV shows I do NOT already own (none from my owned lists) and NONE from the "already recommended or considered" list.',
    '- Favour DIVERSE picks (vary genre, era, country) — never return all-one-flavour.',
    '- Favour WELL-REGARDED, acclaimed shows (these get filtered against a quality bar, so avoid obscure low-rated picks).',
    '- Give a concise one-line reason for each pick.',
    `Return ONLY a JSON object, no prose: {"recommendations":[{"title":"...","year":1999,"reason":"..."}]}. About ${ask} shows.`,
  ].join('\n');
}

function fmtShows(shows: PlexShow[]): string {
  return shows.map((s) => `- ${s.title}${s.year ? ` (${s.year})` : ''}`).join('\n');
}

const LENS_CAP_DEFAULT = 50;

/** Owned shows by any of the given creators/actors (bounded at cap). */
export function ownedByCreators(shows: PlexShow[], creatorNames: string[], cap = LENS_CAP_DEFAULT): PlexShow[] {
  const set = new Set(creatorNames);
  return shows.filter((s) => s.roles.some((r) => set.has(r))).slice(0, cap);
}

/** Owned shows in any of the given genres (bounded at cap). */
export function ownedInGenres(shows: PlexShow[], genres: string[], cap = LENS_CAP_DEFAULT): PlexShow[] {
  const set = new Set(genres);
  return shows.filter((s) => s.genres.some((g) => set.has(g))).slice(0, cap);
}

/** Owned shows released before `beforeYear` (bounded at cap). */
export function ownedPreYear(shows: PlexShow[], beforeYear: number, cap = LENS_CAP_DEFAULT): PlexShow[] {
  return shows.filter((s) => s.year != null && s.year < beforeYear).slice(0, cap);
}

/** Countries considered predominantly Anglophone for world-TV filtering. */
export const ANGLOPHONE_COUNTRIES = new Set([
  'United States', 'United Kingdom', 'Australia', 'Canada', 'New Zealand', 'Ireland',
]);

/** Owned shows with at least one non-Anglophone country (bounded at cap). */
export function ownedNonAnglophone(shows: PlexShow[], cap = LENS_CAP_DEFAULT): PlexShow[] {
  return shows.filter((s) => s.countries.some((c) => !ANGLOPHONE_COUNTRIES.has(c))).slice(0, cap);
}

function lensOwnedBlock(label: string, shows: PlexShow[]): string {
  if (!shows.length) return '';
  return `\n\n${label} (${shows.length} — do NOT re-suggest any of these):\n${fmtShows(shows)}`;
}

function avoidBlock(ctx: BranchContext): string {
  const base = ctx.alreadySuggested ?? ctx.recent;
  const all = [...base, ...(ctx.exclude ?? [])];
  const unique = [...new Set(all)];
  if (!unique.length) return '';
  return `\n\nAlready recommended to me or already considered this run — avoid re-suggesting any of these ${unique.length} specific titles:\n${unique.map((t) => `- ${t}`).join('\n')}`;
}

function topGenresLine(profile: TvTasteProfile, n = 5): string {
  return topGenres(profile, n).map(([g, c]) => `${g} (${c})`).join(', ');
}

function showsInGenre(shows: PlexShow[], genre: string, n: number): PlexShow[] {
  return shows.filter((s) => s.genres.includes(genre)).slice(0, n);
}

// ── The 3 stratified-random serendipity branches ──
function randomBranch(n: number): BranchSpec {
  return {
    id: `tv-rec-random-${n}`,
    lens: 'serendipity',
    kind: 'random',
    description: `Stage: TV serendipity branch ${n} — recommends diverse shows from a stratified-random slice of the owned library.`,
    build(ctx) {
      const sample = stratifiedSample(ctx.shows, { keyFn: primaryGenre, target: ctx.sampleSize, seed: 1000 + n });
      return [
        `You are a TV curator helping me discover new shows. Based on the taste shown by the TV shows I own, recommend shows I would enjoy that I do not already own. Lean towards serendipity and variety, not the obvious next pick.`,
        '',
        `TV shows I already own (a balanced sample of my library — ${sample.length} titles):\n${fmtShows(sample)}`,
        avoidBlock(ctx),
        rules(ctx.ask),
      ].join('\n');
    },
  };
}

// ── Targeted branch 1 (depth): creator/showrunner completion ──
const creatorBranch: BranchSpec = {
  id: 'tv-rec-creator',
  lens: 'creator-completion',
  kind: 'targeted',
  description: 'Stage: creator/showrunner-completion branch (depth) — acclaimed shows by creators I already follow heavily.',
  build(ctx) {
    const creators = creatorsOwnedAtLeast(ctx.profile, 3).slice(0, 8);
    if (!creators.length) return null;
    const creatorLines = creators.map(([c, n]) => `- ${c} (I own ${n})`).join('\n');
    const ownedByThese = ownedByCreators(ctx.shows, creators.map(([c]) => c), ctx.sampleSize);
    return [
      'I follow certain TV creators/actors heavily. Recommend acclaimed or notable shows FEATURING THESE CREATORS that I likely do not own yet — deepen my collection of creators I already love.',
      '',
      `Creators I own at least 3 shows featuring:\n${creatorLines}`,
      lensOwnedBlock('Shows I already own featuring these creators', ownedByThese),
      avoidBlock(ctx),
      rules(ctx.ask),
    ].join('\n');
  },
};

// ── Targeted branch 2 (depth): canon of top genres ──
const canonBranch: BranchSpec = {
  id: 'tv-rec-canon',
  lens: 'top-genre-canon',
  kind: 'targeted',
  description: 'Stage: top-genre-canon branch (depth) — canonical shows in my strongest genres I somehow missed.',
  build(ctx) {
    const tg = topGenres(ctx.profile, 4);
    if (!tg.length) return null;
    const genreNames = tg.map(([g]) => g);
    const sampleLines = tg
      .map(([g]) => `${g}: ${showsInGenre(ctx.shows, g, 4).map((s) => s.title).join(', ')}`)
      .join('\n');
    const ownedInTopGenres = ownedInGenres(ctx.shows, genreNames, ctx.sampleSize);
    return [
      `My strongest TV genres are: ${topGenresLine(ctx.profile, 5)}. Recommend CANONICAL, acclaimed, or landmark shows IN THOSE GENRES that I appear to have missed — blind spots in my own strengths.`,
      '',
      `Sample of what I own in those genres:\n${sampleLines}`,
      lensOwnedBlock('Shows I already own in my top genres', ownedInTopGenres),
      avoidBlock(ctx),
      rules(ctx.ask),
    ].join('\n');
  },
};

// ── Targeted branch 3 (breadth): thin-genre round-out ──
const thinGenreBranch: BranchSpec = {
  id: 'tv-rec-thin-genre',
  lens: 'thin-genre',
  kind: 'targeted',
  description: 'Stage: thin-genre round-out branch (breadth) — acclaimed shows in genres I own few of.',
  build(ctx) {
    const thin = thinGenres(ctx.profile, 5);
    if (!thin.length) return null;
    const thinLine = thin.map(([g, c]) => `${g} (only ${c})`).join(', ');
    const ownedInThinGenres = ownedInGenres(ctx.shows, thin.map(([g]) => g), ctx.sampleSize);
    return [
      `I own very few TV shows in some genres: ${thinLine}. Recommend acclaimed shows in THOSE thin genres to broaden my library — do NOT amplify my dominant genres.`,
      lensOwnedBlock('Shows I already own in these thin genres', ownedInThinGenres),
      avoidBlock(ctx),
      rules(ctx.ask),
    ].join('\n');
  },
};

// ── Targeted branch 4 (breadth): older-era classics ──
const olderEraBranch: BranchSpec = {
  id: 'tv-rec-older-era',
  lens: 'older-era',
  kind: 'targeted',
  description: 'Stage: older-era classics branch (breadth) — acclaimed pre-2000 shows from eras I under-own.',
  build(ctx) {
    const decades = Object.entries(ctx.profile.decades)
      .filter(([d]) => d !== 'Unknown')
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([d, c]) => `${d}: ${c}`)
      .join(', ');
    const ownedOlder = ownedPreYear(ctx.shows, 2000, ctx.sampleSize);
    return [
      `My library skews towards recent TV. Here is my by-decade count: ${decades || '(unknown)'}. Recommend acclaimed PRE-2000 classic TV shows — foundational series from the eras I under-own (the golden age of television and earlier).`,
      lensOwnedBlock('Pre-2000 shows I already own', ownedOlder),
      avoidBlock(ctx),
      rules(ctx.ask),
    ].join('\n');
  },
};

// ── Targeted branch 5 (breadth): world/international TV ──
const worldTvBranch: BranchSpec = {
  id: 'tv-rec-world',
  lens: 'world-tv',
  kind: 'targeted',
  description: 'Stage: world/international TV branch (breadth) — acclaimed non-English shows I under-own.',
  build(ctx) {
    const countries = Object.entries(ctx.profile.countries)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([c, n]) => `${c} (${n})`)
      .join(', ');
    const ownedForeign = ownedNonAnglophone(ctx.shows, ctx.sampleSize);
    return [
      `My TV library is dominated by these countries: ${countries || '(unknown)'} — mostly Anglophone. Recommend acclaimed NON-ENGLISH-LANGUAGE / international TV shows I likely do not own, broadening beyond my Anglophone bias.`,
      lensOwnedBlock('Non-Anglophone shows I already own', ownedForeign),
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
  creatorBranch,
  canonBranch,
  thinGenreBranch,
  olderEraBranch,
  worldTvBranch,
];

/** Look up a branch spec by its job id. */
export function branchById(id: string): BranchSpec {
  const spec = BRANCHES.find((b) => b.id === id);
  if (!spec) throw new Error(`unknown TV recommender branch: ${id}`);
  return spec;
}
