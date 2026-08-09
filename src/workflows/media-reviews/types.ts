// Normalized review shapes — what the lib.ts normalizers produce from the raw
// DynamoDB items. Field names mirror the site's tables (see this folder's
// CLAUDE.md for the exact per-table attribute mapping); everything optional in
// Dynamo stays optional here (absent, never null).

export type ReviewCategory = 'books' | 'movies' | 'tv' | 'albums';

export interface BookReview {
  id: string;
  title: string;
  author: string;
  rating?: number;
  /** The review body (the table's `review_text`), markdown. */
  reviewText?: string;
  /** As stored: 'DD-MM-YYYY'. */
  date?: string;
  editedDate?: string;
  isbn?: string;
  pageCount?: number;
  publisher?: string;
  firstPublishedYear?: number;
  subjects?: string[];
  coverUrl?: string;
  hardcoverRating?: number;
  hardcoverSynopsis?: string;
  seriesName?: string;
  seriesPosition?: number;
}

/** Movies and TV share a byte-identical table shape (MovieRatingsV4 /
 *  TelevisionRatingsV4) — one type covers both. */
export interface ScreenReview {
  id: string;
  title: string;
  rating?: number;
  /** The review body (the table's `review_text`), markdown. */
  reviewText?: string;
  /** As stored: 'DD-MM-YYYY'. */
  date?: string;
  editedDate?: string;
  tmdbId?: number;
  /** ISO 'YYYY-MM-DD' — a DIFFERENT format from `date`. */
  tmdbDate?: string;
  tmdbOverview?: string;
  /** Relative TMDB path ('/xxx.jpg') — needs the image-host prefix. */
  posterPath?: string;
}

/** The nested `lastfm` enrichment map on an album row. `listeners`/`playcount`
 *  are stored as STRINGS by the site — kept as-is, never parsed. */
export interface AlbumLastfm {
  url?: string;
  mbid?: string;
  tags?: string[];
  trackCount?: number;
  /** May contain raw HTML from Last.fm — safe downstream, react-markdown escapes it. */
  summary?: string;
  /** Free-text release date, e.g. '21 May 1997'. */
  releaseDate?: string;
  listeners?: string;
  playcount?: string;
}

export interface AlbumReview {
  id: string;
  title: string;
  artist: string;
  rating?: number;
  /** The review body — the albums table calls this `highlights`, markdown. */
  highlights?: string;
  /** As stored: 'DD-MM-YYYY'. */
  date?: string;
  editedDate?: string;
  /** Full cover-art URL, or absent when the site stored ''. */
  thumbnail?: string;
  lastfm?: AlbumLastfm;
}

/** What a category's render function hands the build engine for one review. */
export interface RenderedReview {
  /** Human-readable display name — becomes the ledger's detail.name and the vault filename. */
  name: string;
  /** The human stem the output filename slug is derived from. */
  stem: string;
  /** The full markdown file content. */
  md: string;
}
