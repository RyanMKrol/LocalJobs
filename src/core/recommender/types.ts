// Shared types for the generic recommender pipeline (T561) — extracted from the
// near-identical movies/tv-recs implementations. A "domain" (movies or TV) wires
// its own item shape, TMDB endpoint, genre table, and copy into a
// RecommenderDomain object; the pipeline (branch.ts/merge.ts/notify.ts) is
// generic over that domain and never references movies/TV specifics directly.

/** One raw suggestion from a recommender branch's Claude call, before TMDB verification. */
export interface RawSuggestion {
  title: string;
  year: number | null;
  reason: string;
  /** Which branch produced it (e.g. "auteur-completion", "world-cinema"). */
  lens: string;
}

/** A recommender branch's output artifact (one file per branch). */
export interface BranchOutputFile {
  branchId: string;
  lens: string;
  generatedAt: string;
  suggestions: RawSuggestion[];
  /** Set when the branch was skipped/failed gracefully (junk LLM output, etc.). */
  error?: string;
}

/** One TMDB-verified recommendation (the merge stage's output unit). */
export interface Recommendation {
  tmdbId: number;
  title: string;
  year: number | null;
  reason: string;
  /** The branch lens(es) that surfaced it (first wins; merged on dedup). */
  lens: string;
  /** Primary TMDB genre name (for balancing + display). */
  genre: string;
  /** TMDB vote_average (context only). */
  tmdbRating: number | null;
}

/** Merge-stage artifact: the verified, deduped, balanced recommendation list. */
export interface RecommendationsFile {
  generatedAt: string;
  /** How many raw suggestions the branches pooled. */
  pooled: number;
  recommendations: Recommendation[];
}

/**
 * Append-only history of recommended items, fed back into branch prompts so
 * successive runs vary. `tmdbId`/`at` are optional ONLY so the parse stays
 * tolerant of legacy 2-field `{ title, year }` rows written before both
 * workflows' history schemas were aligned (T560) — new rows always carry all
 * four fields.
 */
export interface RecsHistoryFile {
  recommended: Array<{ tmdbId?: number; title: string; year?: number | null; at?: string }>;
}

export type BranchKind = 'random' | 'targeted';

/** Context handed to a branch's `build()` — generic over the domain's item (M) and taste-profile (P) shapes. */
export interface BranchContext<M, P> {
  profile: P;
  /** The owned-library items (movies or shows) available to this branch. */
  items: M[];
  /** Recent recommendation titles to steer the model away from repeats (legacy window). */
  recent: string[];
  /** Owned-library sample size to show (stratified; used by random branches). */
  sampleSize: number;
  /** How many items to ask Claude for (headroom above the eventual target). */
  ask: number;
  /** Extra titles to exclude (top-up: everything already collected this run). */
  exclude?: string[];
  /**
   * Full already-recommended/ignored title list, bounded to `recsHistoryContext`.
   * When present, replaces `recent` as the "do not re-suggest" context (broader).
   */
  alreadySuggested?: string[];
}

/**
 * What a branch's `build()` reports alongside the prompt: the EXACT owned items
 * (M) it selected and put into that prompt — the branch's real lens-filtered
 * subset (targeted branches) or stratified sample (random branches), never a
 * post-hoc reconstruction. Recorded verbatim as `input-sample` ledger rows so
 * the run page's Inputs panel shows what a branch was ACTUALLY shown, not a
 * recomputed guess (T615).
 */
export interface BranchBuildResult<M> {
  prompt: string;
  sampledItems: M[];
}

export interface BranchSpec<M, P> {
  /** Job name (unique, stable DB key) AND the lens tag on its suggestions. */
  id: string;
  lens: string;
  kind: BranchKind;
  description: string;
  /**
   * Build the branch prompt plus the exact owned items it selected for that
   * prompt, or return null to SKIP (e.g. auteur-completion when no director
   * qualifies) — a skipped branch writes empty suggestions and the run
   * continues.
   */
  build(ctx: BranchContext<M, P>): BranchBuildResult<M> | null;
}

/** A single TMDB search match, normalized to the fields the merge pipeline needs (domain owns the raw endpoint/field mapping). */
export interface TmdbSearchMatch {
  id: number;
  title: string;
  year: number | null;
  vote_average?: number;
  vote_count?: number;
  genre_ids?: number[];
}

/** The tuning/path config every merge/branch run needs — `moviesConfig`/`tvRecsConfig` both satisfy this shape structurally. */
export interface RecommenderConfig {
  snapshotOut: string;
  tasteOut: string;
  recsHistoryOut: string;
  recsDir: string;
  recsOut: string;
  reportDir: string;
  recsModel: string;
  recsSampleSize: number;
  recsPerBranchAsk: number;
  recsTarget: number;
  recsGenreCap: number;
  recsMinRating: number;
  recsMinVotes: number;
  recsTopUpRounds: number;
  recsTopUpConcurrency: number;
  recsRecentWindow: number;
  recsHistoryContext: number;
}

/**
 * Everything the shared pipeline needs to know about ONE domain (movies or TV).
 * `M` is the owned-item shape (PlexMovie/PlexShow), `P` the taste-profile shape.
 */
export interface RecommenderDomain<M, P> {
  /** work_items ledger job name for the recs dedup/ignore ledger, e.g. 'movie-recs' / 'tv-recs'. */
  recsJob: string;
  /** The snapshot stage's job name, used in "run X first" error hints, e.g. 'movie-snapshot'. */
  snapshotStageName: string;
  /** Log-banner label for the merge stage, e.g. 'rec-merge' / 'tv-rec-merge'. */
  mergeStageName: string;
  /** Log-banner label for the notify stage, e.g. 'movie-recs-notify' / 'tv-recs-notify'. */
  notifyStageName: string;
  config: RecommenderConfig;
  branches: BranchSpec<M, P>[];
  /** Pull the owned-item array out of the domain's snapshot JSON shape. */
  itemsOf(snapshot: unknown): M[];
  /** Pull the taste profile out of the domain's taste-profile JSON shape. */
  profileOf(taste: unknown): P;
  /** TMDB title search — domain owns the endpoint + field mapping. */
  search(title: string, year: number | null): Promise<TmdbSearchMatch | null>;
  /** Map TMDB genre_ids[] to a single primary genre name (domain-specific genre table). */
  genreName(ids: number[] | undefined): string;
  /** TMDB web link for a recommended item's tmdbId. */
  tmdbUrl(tmdbId: number): string;
  /** Digest title/body builder (emoji, noun, and name-cap all differ per domain). */
  buildDigest(recs: Recommendation[]): { count: number; title: string; body: string };
  /** notifier `job` tag + `tags` (ntfy icon) for the digest push call. */
  pushJob: string;
  pushTags: string;
  /** Markdown report filename (under reportDir) + heading + empty-state line. */
  reportFilename: string;
  reportHeading: string;
  reportEmptyLine: string;
  /** Extra fields merged into a notified item's ledger `detail` (e.g. tv's tmdbUrl). */
  extraNotifyDetail?(r: Recommendation): Record<string, unknown>;
}
