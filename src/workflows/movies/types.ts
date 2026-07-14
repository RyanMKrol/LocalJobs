// Shared types for the Plex movie franchise-gap audit workflow.

/** One movie as snapshotted from Plex (stage 1 output), with taste metadata. */
export interface PlexMovie {
  title: string;
  year: number | null;
  /** The TMDB id parsed from the movie's `tmdb://` GUID, or null if absent. */
  tmdbId: number | null;
  /** Plex's stable ratingKey for the movie. */
  ratingKey: string;
  /** Genres Plex already returns (e.g. ["Action", "Sci-Fi"]). */
  genres: string[];
  /** Directors Plex already returns. */
  directors: string[];
  /** Countries Plex already returns. */
  countries: string[];
  /** Audience (user) rating 0–10, or null. */
  audienceRating: number | null;
  /** Critic rating 0–10, or null. */
  rating: number | null;
}

/** Per-key counts derived from the owned library (T146 consumes this). */
export interface TasteProfile {
  totalMovies: number;
  withTmdbId: number;
  /** genre → owned count. */
  genres: Record<string, number>;
  /** director → owned count. */
  directors: Record<string, number>;
  /** decade label (e.g. "1990s") → owned count. */
  decades: Record<string, number>;
  /** country → owned count. */
  countries: Record<string, number>;
}

/** stage 1 artifact: the fresh-every-run Plex movie snapshot. */
export interface MovieSnapshotFile {
  generatedAt: string;
  section: string;
  movies: PlexMovie[];
}

/** stage 1 artifact: the taste profile (separate file). */
export interface TasteProfileFile {
  generatedAt: string;
  profile: TasteProfile;
}

/** One missing franchise film the owner does NOT own. */
export interface FranchiseGap {
  collectionId: number;
  collectionName: string;
  tmdbId: number;
  title: string;
  year: number | null;
  /** TMDB vote_average (0–10) for the owner's CONTEXT only — never used to hide. */
  tmdbRating: number | null;
}

/** stage 2 artifact: the fresh-every-run franchise-gap detection. */
export interface FranchiseGapsFile {
  generatedAt: string;
  /** Distinct collections inspected. */
  collectionsChecked: number;
  /** Every factual gap — NO quality filter, NO skip heuristics. */
  gaps: FranchiseGap[];
  /**
   * Per-collection name → one owned example film (title + year). Present for
   * each collection that has ≥1 gap AND ≥1 owned part, so the report can show a
   * recognisable anchor alongside the missing list.
   */
  collectionExamples?: Record<string, { title: string; year: number | null }>;
}

// ── Recommendation layer (T146) — the branch/merge/notify artifact shapes are
// generic across domains and now live in the shared recommender pipeline
// (T561); re-exported here so existing imports from './types.js' keep working. ──
export type {
  BranchOutputFile,
  RawSuggestion,
  Recommendation,
  RecommendationsFile,
  RecsHistoryFile,
} from '../../core/recommender/types.js';

/** One TMDB `/search/movie` result (only the fields we read). */
export interface TmdbSearchResult {
  id: number;
  title?: string;
  release_date?: string | null;
  vote_average?: number;
  /** Number of TMDB votes — a quality floor so a fluke rating can't sneak in (T162). */
  vote_count?: number;
  genre_ids?: number[];
  original_language?: string;
}

/** TMDB `/search/movie` response. */
export interface TmdbSearchResponse {
  results?: TmdbSearchResult[];
}

// ── Minimal Plex / TMDB response shapes (only the fields we read) ──

export interface PlexGuid { id?: string }
export interface PlexTag { tag?: string }
export interface PlexMovieMeta {
  title?: string;
  year?: number;
  ratingKey?: string | number;
  audienceRating?: number;
  rating?: number;
  Guid?: PlexGuid[];
  Genre?: PlexTag[];
  Director?: PlexTag[];
  Country?: PlexTag[];
}

/** TMDB `/movie/{id}` — only `belongs_to_collection`. */
export interface TmdbMovieDetail {
  belongs_to_collection?: { id: number; name: string } | null;
}

/** One film in a TMDB collection's `parts[]`. */
export interface TmdbCollectionPart {
  id: number;
  title?: string;
  release_date?: string | null;
  vote_average?: number;
}

/** TMDB `/collection/{id}`. */
export interface TmdbCollectionDetail {
  id: number;
  name?: string;
  parts?: TmdbCollectionPart[];
}
