// Shared types for the Plex space-saver size-breakdown workflow.

/** Minimal shape of a Plex `Media.Part` — only the field we read. */
export interface PlexPart {
  size?: number;
}
export interface PlexMedia {
  Part?: PlexPart[];
}

/** Minimal shape of a movie item from `/library/sections/<id>/all`. */
export interface PlexMovieMeta {
  title?: string;
  year?: number;
  ratingKey?: string | number;
  Media?: PlexMedia[];
}

/** Minimal shape of a TV show item from `/library/sections/<id>/all`. */
export interface PlexShowMeta {
  title?: string;
  year?: number;
  ratingKey?: string | number;
}

/** Minimal shape of a flat episode item from `/library/sections/<id>/all?type=4`. */
export interface PlexEpisodeMeta {
  grandparentRatingKey?: string | number;
  Media?: PlexMedia[];
}

/** One row of the biggest-first size breakdown — one movie, or one whole TV show. */
export interface SizeBreakdownItem {
  title: string;
  year: number | null;
  type: 'movie' | 'show';
  ratingKey: string;
  bytes: number;
  /** Human-readable size, e.g. "12.3 GB". */
  human: string;
}

/** The persisted prior-run baseline used to detect a run-over-run size drop. */
export interface SizeBaselineFile {
  totalBytes: number;
  /** ISO timestamp of the run this baseline was recorded from. */
  at: string;
}

/** The workflow's output artifact — the biggest-first size breakdown. */
export interface SizeBreakdownFile {
  generatedAt: string;
  movieSection: string;
  tvSection: string;
  totalBytes: number;
  totalHuman: string;
  movieCount: number;
  showCount: number;
  /** Sorted biggest-first. */
  items: SizeBreakdownItem[];
}
