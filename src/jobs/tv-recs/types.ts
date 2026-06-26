// Shared types for the Plex TV recommendations workflow.

/** One TV show as snapshotted from Plex (stage 1 output), with taste metadata. */
export interface PlexShow {
  title: string;
  year: number | null;
  /** The TMDB id parsed from the show's `tmdb://` GUID, or null if absent. */
  tmdbId: number | null;
  /** Plex's stable ratingKey for the show. */
  ratingKey: string;
  /** Genres Plex returns (e.g. ["Drama", "Crime"]). */
  genres: string[];
  /** Roles/actors Plex returns. */
  roles: string[];
  /** Countries Plex returns. */
  countries: string[];
  /** Studio / network Plex returns. */
  studio: string | null;
  /** Audience (user) rating 0–10, or null. */
  audienceRating: number | null;
  /** Critic rating 0–10, or null. */
  rating: number | null;
  /** Number of seasons Plex has for this show. */
  seasonCount: number | null;
}

/** Per-key counts derived from the owned TV library. */
export interface TvTasteProfile {
  totalShows: number;
  withTmdbId: number;
  /** genre → owned count. */
  genres: Record<string, number>;
  /** role/actor → owned count. */
  roles: Record<string, number>;
  /** decade label (e.g. "1990s") → owned count. */
  decades: Record<string, number>;
  /** country → owned count. */
  countries: Record<string, number>;
}

/** Stage 1 artifact: the fresh-every-run Plex TV snapshot. */
export interface TvSnapshotFile {
  generatedAt: string;
  section: string;
  shows: PlexShow[];
}

/** Stage 1 artifact: the TV taste profile (separate file). */
export interface TvTasteProfileFile {
  generatedAt: string;
  profile: TvTasteProfile;
}

/** One raw TV show suggestion from a recommender branch. */
export interface RawSuggestion {
  title: string;
  year: number | null;
  reason: string;
  /** Which branch produced it. */
  lens: string;
}

/** A recommender branch's output artifact (one file per branch). */
export interface BranchOutputFile {
  branchId: string;
  lens: string;
  generatedAt: string;
  suggestions: RawSuggestion[];
  /** Set when the branch was skipped/failed gracefully. */
  error?: string;
}

/** One TMDB-verified TV recommendation (the merge stage's output unit). */
export interface Recommendation {
  tmdbId: number;
  title: string;
  year: number | null;
  reason: string;
  /** The branch lens(es) that surfaced it. */
  lens: string;
  /** Primary TMDB genre name (for balancing + display). */
  genre: string;
  /** TMDB vote_average (context only). */
  tmdbRating: number | null;
}

/** Merge-stage artifact: the verified, deduped, balanced recommendation list. */
export interface RecommendationsFile {
  generatedAt: string;
  pooled: number;
  recommendations: Recommendation[];
}

/** Persisted cross-run history of past recommendations (for avoid-re-suggesting). */
export interface RecsHistoryFile {
  recommended: Array<{ title: string; year?: number | null }>;
}

// ── Minimal Plex response shapes (only the fields we read) ──

export interface PlexGuid { id?: string }
export interface PlexTag { tag?: string }
export interface PlexShowMeta {
  title?: string;
  year?: number;
  ratingKey?: string | number;
  audienceRating?: number;
  rating?: number;
  childCount?: number;
  studio?: string;
  Guid?: PlexGuid[];
  Genre?: PlexTag[];
  Role?: PlexTag[];
  Country?: PlexTag[];
}
