// Shared types for the plex-profiles per-title markdown builder.

/** One `Guid[]` entry from a detail fetch — e.g. `{ id: "tmdb://1146556" }`. */
export interface PlexGuid {
  id?: string;
}

/** A Plex tag array entry (`Genre`/`Country`/`Director`/`Writer`/`Role`), e.g. `{ tag: "Action" }`. */
export interface PlexTag {
  tag?: string;
}

/** Minimal per-source rating entry from a detail fetch's `Rating[]`. */
export interface PlexRating {
  image?: string;
  value?: number;
  type?: string;
}

/** Minimal stream summary — only the fields worth surfacing in a text profile. */
export interface PlexStream {
  videoResolution?: string;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  language?: string;
}

export interface PlexPart {
  size?: number;
  file?: string;
}

export interface PlexMedia {
  videoResolution?: string;
  videoCodec?: string;
  container?: string;
  Part?: PlexPart[];
}

/** Minimal shape of a flat episode item from `/library/sections/<id>/all?type=4`. */
export interface PlexEpisodeMeta {
  grandparentRatingKey?: string | number;
  Media?: PlexMedia[];
}

/** Minimal list-endpoint shape shared by movies/shows (from `/library/sections/<id>/all`). */
export interface PlexListItem {
  ratingKey?: string | number;
  slug?: string;
  title?: string;
  updatedAt?: number;
}

/** Full detail for one movie, from `GET /library/metadata/<ratingKey>`. */
export interface PlexMovieDetail {
  ratingKey?: string | number;
  guid?: string;
  slug?: string;
  studio?: string;
  title?: string;
  titleSort?: string;
  contentRating?: string;
  contentRatingAge?: number;
  summary?: string;
  rating?: number;
  audienceRating?: number;
  year?: number;
  tagline?: string;
  duration?: number;
  originallyAvailableAt?: string;
  addedAt?: number;
  updatedAt?: number;
  Media?: PlexMedia[];
  Genre?: PlexTag[];
  Country?: PlexTag[];
  Director?: PlexTag[];
  Writer?: PlexTag[];
  Role?: PlexTag[];
  Guid?: PlexGuid[];
  Rating?: PlexRating[];
}

/** Full detail for one TV show, from `GET /library/metadata/<ratingKey>`. */
export interface PlexShowDetail {
  ratingKey?: string | number;
  guid?: string;
  slug?: string;
  studio?: string;
  title?: string;
  originalTitle?: string;
  titleSort?: string;
  contentRating?: string;
  contentRatingAge?: number;
  summary?: string;
  rating?: number;
  audienceRating?: number;
  year?: number;
  duration?: number;
  originallyAvailableAt?: string;
  addedAt?: number;
  updatedAt?: number;
  leafCount?: number;
  childCount?: number;
  Genre?: PlexTag[];
  Country?: PlexTag[];
  Role?: PlexTag[];
  Guid?: PlexGuid[];
  Rating?: PlexRating[];
}
