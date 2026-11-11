// The records the plex-poster-backup stages pass along, and the manifest format
// of the archive. The manifest is the same shape (version 1) as the one the
// original PlexUtils `pull-posters` command wrote, so an archive started there
// carries straight on here and the restore script reads both.

export type PosterItemType = 'movie' | 'show' | 'season';

/** One film, show or season as Plex lists it, with the path of its current poster. */
export interface PosterItem {
  type: PosterItemType;
  ratingKey: string;
  /** Plex's own id for the title (`plex://movie/…`). Survives a re-match; a ratingKey does not. */
  guid: string | null;
  sectionId: string;
  sectionTitle: string;
  title: string;
  year: string | null;
  /** `/library/metadata/<id>/thumb/<version>`. Null when the item has no poster. */
  thumb: string | null;
  /** Season number (seasons only). */
  index?: number | null;
  /** The show a season belongs to (seasons only). */
  show?: { ratingKey: string; guid: string | null; title: string; year: string | null };
}

/** An image in the archive, named by the SHA-1 of its bytes. */
export interface StoredImage {
  sha1: string;
  /** Path inside the archive: `images/<sha1>.<ext>`. */
  file: string;
  bytes: number;
  contentType: string;
}

export interface PosterItemWithImage extends PosterItem {
  image: StoredImage | null;
}

/** What the list stage writes: every item in every film and TV library. */
export interface PosterList {
  generatedAt: string;
  server: { machineIdentifier: string };
  sections: { id: string; title: string; type: string }[];
  items: PosterItem[];
}

export interface FetchCounts {
  items: number;
  downloaded: number;
  reused: number;
  noPoster: number;
  failed: number;
}

export interface FetchError {
  ratingKey: string;
  label: string;
  error: string;
}

/** What the fetch stage writes: the same items, each with the archived image it now points at. */
export interface PosterSet {
  generatedAt: string;
  server: { machineIdentifier: string };
  counts: FetchCounts;
  errors: FetchError[];
  items: PosterItemWithImage[];
}

/** A snapshot file in the archive (`snapshots/posters-<stamp>.json`, and `latest.json`). */
export interface SnapshotManifest {
  version: 1;
  createdAt: string;
  server: { machineIdentifier: string; host?: string };
  filters: null;
  counts: FetchCounts;
  errors: FetchError[];
  items: PosterItemWithImage[];
}

export interface PosterChange {
  label: string;
  type: PosterItemType;
  ratingKey: string;
  /** SHA-1 of the poster in the previous snapshot, null if it had none. */
  from: string | null;
  /** SHA-1 of the poster now, null if it has none. */
  to: string | null;
  /** Archive path of the poster now, for a preview. */
  file: string | null;
}

/** What the record stage writes: what this week's snapshot is and how it differs from the last one. */
export interface BackupReport {
  createdAt: string;
  /** Path inside the archive of the snapshot just written. */
  snapshotFile: string;
  /** `createdAt` of the snapshot this one was compared with, null for the first. */
  previousSnapshot: string | null;
  counts: FetchCounts;
  /** Distinct images this snapshot refers to, and their total size. */
  images: { distinct: number; bytes: number };
  /** Titles in both snapshots (the base the changed share is measured against). */
  compared: number;
  changed: number;
  added: number;
  removed: number;
  /** changed / compared, as a percentage. 0 for the first snapshot. */
  changedPct: number;
  /** Up to CHANGE_LIST_CAP entries each; the counts above are the full numbers. */
  changes: PosterChange[];
  addedSample: string[];
  removedSample: string[];
  /** Posters that could not be downloaded this run (recorded with no image). */
  failures: FetchError[];
}
