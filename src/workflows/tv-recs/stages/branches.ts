// The 8 TV recommender branch specs: 3 stratified-random serendipity branches +
// 5 targeted branches (creator/showrunner-completion, top-genre-canon,
// thin-genre round-out, older-era classics, world/international TV).
// Pure prompt construction — no I/O. Mirrors src/workflows/movies/stages/branches.ts.
//
// T561: the branch-runner mechanics (loading snapshot/taste/history, calling
// Claude, parsing) moved to src/core/recommender/branch.ts. This file keeps only
// the TV-specific lens PROMPT TEXT + the `tvDomain` wiring object the shared
// pipeline (branch/merge/notify) is parameterized over.
import { callService } from '../../../core/services.js';
import { tmdbGet } from '../../../core/plex-client.js';
import {
  creatorsOwnedAtLeast,
  primaryGenre,
  RECS_JOB,
  stratifiedSample,
  thinGenres,
  topGenres,
} from '../recs.js';
import { tvRecsConfig } from '../config.js';
import type { PlexShow, TvTasteProfile } from '../types.js';
import type {
  BranchContext as CoreBranchContext,
  BranchSpec as CoreBranchSpec,
  RecommenderDomain,
  Recommendation,
  TmdbSearchMatch,
} from '../../../core/recommender/types.js';

export type BranchKind = 'random' | 'targeted';
export type BranchContext = CoreBranchContext<PlexShow, TvTasteProfile>;
export type BranchSpec = CoreBranchSpec<PlexShow, TvTasteProfile>;

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
    description: `TV recommender serendipity branch ${n} of 3, one of eight parallel branches fanning out ` +
      'from the tv-snapshot stage. It reads the owned-library snapshot and taste profile and asks Claude ' +
      'for acclaimed, diverse recommendations drawn from a stratified-random slice of the owned shows ' +
      `(sampled by primary genre, seeded uniquely per branch — ${1000 + n} — so the three random branches ` +
      'see different slices and surface different picks), rather than steering towards any one genre or ' +
      "era the way the targeted branches do. It excludes titles already owned and anything on this run's " +
      'growing already-suggested list, then writes its raw suggestion list for tv-rec-merge to pool, ' +
      'TMDB-verify, dedupe against the other seven branches, and quality-filter.',
    build(ctx) {
      const sample = stratifiedSample(ctx.items, { keyFn: primaryGenre, target: ctx.sampleSize, seed: 1000 + n });
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
  description: 'TV recommender depth branch: creator/showrunner completion. It reads the owned-library ' +
    'taste profile to find creators/actors the owner already follows heavily (owns at least 3 shows ' +
    'featuring them, up to 8 such names) and asks Claude for acclaimed or notable shows featuring those ' +
    'same people that are not already owned — deepening a collection around creators already loved rather ' +
    'than branching out. When no creator meets the "owns at least 3" threshold the branch build() returns ' +
    'null and the stage writes an empty suggestion list without calling Claude, a deliberate skip rather ' +
    'than a failure. Otherwise it writes its raw suggestion list for tv-rec-merge to pool, TMDB-verify, ' +
    'dedupe, and quality-filter alongside the other seven branches.',
  build(ctx) {
    const creators = creatorsOwnedAtLeast(ctx.profile, 3).slice(0, 8);
    if (!creators.length) return null;
    const creatorLines = creators.map(([c, n]) => `- ${c} (I own ${n})`).join('\n');
    const ownedByThese = ownedByCreators(ctx.items, creators.map(([c]) => c), ctx.sampleSize);
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
  description: 'TV recommender depth branch: top-genre canon. It reads the owned-library taste profile to ' +
    'find the owner\'s 4 strongest genres by owned-show count, shows Claude a small sample of what is ' +
    'already owned in each, and asks for canonical, acclaimed, or landmark shows in those SAME genres that ' +
    'appear to be missing — blind spots inside the owner\'s own strengths, rather than branching into new ' +
    'territory. When the taste profile has no genre data the branch build() returns null and the stage ' +
    'writes an empty suggestion list without calling Claude. Otherwise it writes its raw suggestion list ' +
    'for tv-rec-merge to pool, TMDB-verify, dedupe, and quality-filter alongside the other seven branches.',
  build(ctx) {
    const tg = topGenres(ctx.profile, 4);
    if (!tg.length) return null;
    const genreNames = tg.map(([g]) => g);
    const sampleLines = tg
      .map(([g]) => `${g}: ${showsInGenre(ctx.items, g, 4).map((s) => s.title).join(', ')}`)
      .join('\n');
    const ownedInTopGenres = ownedInGenres(ctx.items, genreNames, ctx.sampleSize);
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
  description: 'TV recommender breadth branch: thin-genre round-out. It reads the owned-library taste ' +
    'profile to find the 5 genres the owner owns the fewest shows in, shows Claude a sample of what is ' +
    'already owned in those thin genres, and asks for acclaimed shows in THOSE genres specifically — ' +
    "broadening the library rather than amplifying already-dominant genres the way the canon branch does. " +
    'When the taste profile shows no thin genres the branch build() returns null and the stage writes an ' +
    'empty suggestion list without calling Claude. Otherwise it writes its raw suggestion list for ' +
    'tv-rec-merge to pool, TMDB-verify, dedupe, and quality-filter alongside the other seven branches.',
  build(ctx) {
    const thin = thinGenres(ctx.profile, 5);
    if (!thin.length) return null;
    const thinLine = thin.map(([g, c]) => `${g} (only ${c})`).join(', ');
    const ownedInThinGenres = ownedInGenres(ctx.items, thin.map(([g]) => g), ctx.sampleSize);
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
  description: 'TV recommender breadth branch: older-era classics. It reads the owned-library taste ' +
    'profile\'s by-decade breakdown to show Claude how much of the owned library skews recent, shows a ' +
    'sample of the pre-2000 shows already owned, and asks for acclaimed PRE-2000 classic TV shows — ' +
    "foundational series from the golden age of television and earlier that the owner under-owns, " +
    'broadening the library backwards in time rather than sideways by genre or country. It writes its raw ' +
    'suggestion list for tv-rec-merge to pool, TMDB-verify, dedupe, and quality-filter alongside the other ' +
    'seven branches.',
  build(ctx) {
    const decades = Object.entries(ctx.profile.decades)
      .filter(([d]) => d !== 'Unknown')
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([d, c]) => `${d}: ${c}`)
      .join(', ');
    const ownedOlder = ownedPreYear(ctx.items, 2000, ctx.sampleSize);
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
  description: 'TV recommender breadth branch: world/international TV. It reads the owned-library taste ' +
    'profile\'s by-country breakdown to show Claude how Anglophone-dominated the owned library is, shows a ' +
    'sample of non-Anglophone shows already owned, and asks for acclaimed NON-ENGLISH-LANGUAGE / ' +
    'international shows that broaden the library beyond that Anglophone bias — a distinct axis from the ' +
    'genre- and era-focused breadth branches. It writes its raw suggestion list for tv-rec-merge to pool, ' +
    'TMDB-verify, dedupe, and quality-filter alongside the other seven branches.',
  build(ctx) {
    const countries = Object.entries(ctx.profile.countries)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([c, n]) => `${c} (${n})`)
      .join(', ');
    const ownedForeign = ownedNonAnglophone(ctx.items, ctx.sampleSize);
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

// ── Domain wiring: everything the shared pipeline needs to know about TV shows ──

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

// ── TMDB TV genre id → name (fixed public TMDB list) ──

const TMDB_TV_GENRES: Record<number, string> = {
  10759: 'Action & Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 10762: 'Kids',
  9648: 'Mystery', 10763: 'News', 10764: 'Reality', 10765: 'Sci-Fi & Fantasy',
  10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics', 37: 'Western',
};

export function genreNameFromIds(ids: number[] | undefined): string {
  for (const id of ids ?? []) if (TMDB_TV_GENRES[id]) return TMDB_TV_GENRES[id];
  return 'Unknown';
}

/** Map a raw TMDB `/search/tv` result onto the shared pipeline's normalized shape. */
export function mapTmdbTvSearchResult(result: TmdbTvSearchResult | null, title: string, year: number | null): TmdbSearchMatch | null {
  if (!result) return null;
  const airDate = result.first_air_date;
  return {
    id: result.id,
    title: result.name ?? title,
    year: airDate ? Number(airDate.slice(0, 4)) || year : year,
    vote_average: result.vote_average,
    vote_count: result.vote_count,
    genre_ids: result.genre_ids,
  };
}

const defaultSearchTv = (title: string, year: number | null): Promise<TmdbSearchMatch | null> =>
  callService(
    'tmdb',
    async () => {
      const params = new URLSearchParams({ query: title, include_adult: 'false' });
      if (year != null) params.set('first_air_date_year', String(year));
      const resp = await tmdbGet<TmdbTvSearchResponse>(`/search/tv?${params.toString()}`);
      return mapTmdbTvSearchResult(resp.results?.[0] ?? null, title, year);
    },
    { cacheKey: `tmdb:search:tv:${title}${year != null ? `:${year}` : ''}` },
  );

/** Build a digest title + body for the new TV recommendations. */
export function buildDigest(recs: Recommendation[]): { count: number; title: string; body: string } {
  const r = recs.length;
  const names = recs.map((x) => x.title).slice(0, 10);
  const body = names.join(', ') + (recs.length > names.length ? `, +${recs.length - names.length} more` : '');
  const title = `📺 ${r} TV show recommendation${r === 1 ? '' : 's'}`;
  return { count: r, title, body };
}

function tmdbLink(tmdbId: number): string {
  return `https://www.themoviedb.org/tv/${tmdbId}`;
}

export const tvDomain: RecommenderDomain<PlexShow, TvTasteProfile> = {
  recsJob: RECS_JOB,
  snapshotStageName: 'tv-snapshot',
  mergeStageName: 'tv-rec-merge',
  notifyStageName: 'tv-recs-notify',
  config: tvRecsConfig,
  branches: BRANCHES,
  itemsOf: (snapshot) => (snapshot as { shows?: PlexShow[] }).shows ?? [],
  profileOf: (taste) => (taste as { profile: TvTasteProfile }).profile,
  search: defaultSearchTv,
  genreName: genreNameFromIds,
  tmdbUrl: tmdbLink,
  buildDigest,
  pushJob: 'tv-recs',
  pushTags: 'television',
  reportFilename: 'tv-recommendations.md',
  reportHeading: '# TV show recommendations',
  reportEmptyLine: '_No active recommendations._',
  extraNotifyDetail: (r) => ({ tmdbUrl: tmdbLink(r.tmdbId) }),
};
