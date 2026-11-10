// Shared types for the Plex new-seasons audit workflow.

/** One TV show as snapshotted from Plex (stage 1 output). */
export interface PlexShow {
  title: string;
  year: number | null;
  /** The TMDB id parsed from the show's `tmdb://` GUID, or null if absent. */
  tmdbId: number | null;
  /** Plex's stable ratingKey for the show (== episodes' grandparentRatingKey). */
  ratingKey: string;
  /** Highest owned REGULAR season = max episode parentIndex (>0); 0 if none. */
  highestOwnedSeason: number;
}

/** stage 1 artifact: the fresh-every-run Plex library snapshot. */
export interface SnapshotFile {
  generatedAt: string;
  section: string;
  shows: PlexShow[];
}

/** One actionable show: it has complete season(s) on TMDB the owner doesn't have. */
export interface ShowMissingSeasons {
  title: string;
  year: number | null;
  tmdbId: number;
  ratingKey: string;
  highestOwnedSeason: number;
  /** TMDB series status ("Ended" / "Returning Series" / "Canceled" / …). */
  tmdbStatus: string;
  /** Highest REGULAR season already aired on TMDB (air_date ≤ now). */
  highestAiredSeason: number;
  /** Seasons owned+1..aired that are COMPLETE (every episode aired). */
  completeMissingSeasons: number[];
}

/** A show we could not check because it carries no `tmdb://` GUID. */
export interface UnverifiableShow {
  title: string;
  ratingKey: string;
}

/** A show whose TMDB check errored this run (it is retried next run). */
export interface ErroredShow {
  title: string;
  tmdbId: number;
  error: string;
}

/** stage 2 artifact: the fresh-every-run TMDB completeness check. */
export interface MissingSeasonsFile {
  generatedAt: string;
  /** Only ACTIONABLE shows (≥1 complete missing season). */
  shows: ShowMissingSeasons[];
  /** Shows skipped because they have no tmdbId (never guessed). */
  unverifiable: UnverifiableShow[];
  /** Shows whose check failed this run. Absent in files written before this field existed. */
  errors?: ErroredShow[];
}

// ── Minimal Plex / TMDB response shapes (only the fields we read) ──

export interface PlexGuid { id?: string }
export interface PlexShowMeta {
  title?: string;
  year?: number;
  ratingKey?: string | number;
  Guid?: PlexGuid[];
}
export interface PlexEpisodeMeta {
  grandparentRatingKey?: string | number;
  /** Season number of the episode. */
  parentIndex?: number;
}

export interface TmdbSeasonSummary {
  season_number: number;
  air_date: string | null;
  episode_count?: number;
}
export interface TmdbSeriesDetail {
  status?: string;
  seasons?: TmdbSeasonSummary[];
}
export interface TmdbEpisode {
  air_date: string | null;
  episode_number?: number;
}
export interface TmdbSeasonDetail {
  episodes?: TmdbEpisode[];
}
