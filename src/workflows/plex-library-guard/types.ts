// Shared types for the Plex library-guard workflow (per-file snapshot + deletion alerts).

/** Minimal shape of a Plex `Media.Part`: the fields the guard reads. */
export interface GuardPart {
  id?: number;
  file?: string;
  size?: number;
}
export interface GuardMedia {
  Part?: GuardPart[];
}

/** Minimal shape of a movie item from `/library/sections/<id>/all`. */
export interface GuardMovieMeta {
  title?: string;
  year?: number;
  ratingKey?: string | number;
  Media?: GuardMedia[];
}

/** Minimal shape of a flat episode item from `/library/sections/<id>/all?type=4`. */
export interface GuardEpisodeMeta {
  title?: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  ratingKey?: string | number;
  Media?: GuardMedia[];
}

/** One media FILE in the snapshot: one entry per `Media.Part` (a 2-part movie = 2 entries). */
export interface SnapshotFileEntry {
  /** Stable identity: `<ratingKey>::<part.id ?? part.file ?? '#'+index>`. */
  key: string;
  ratingKey: string;
  type: 'movie' | 'episode';
  /** "Heat (1995)" for a movie, "The Wire — S01E03 — The Buys" for an episode. */
  title: string;
  /** The on-disk path Plex reports for this part, when present. */
  file: string | null;
  bytes: number;
}

/** The persisted baseline: the full library inventory as of the last successful run. */
export interface LibrarySnapshotFile {
  generatedAt: string;
  movieSection: string;
  tvSection: string;
  totalBytes: number;
  totalHuman: string;
  fileCount: number;
  files: SnapshotFileEntry[];
}

/** The small always-written per-run summary (never the full inventory). */
export interface GuardReportFile {
  generatedAt: string;
  firstRun: boolean;
  totalBytes: number;
  totalHuman: string;
  fileCount: number;
  prev: { generatedAt: string; totalBytes: number; fileCount: number } | null;
  /** `prev.totalBytes - current.totalBytes` (positive = shrink). 0 on the first run. */
  dropBytes: number;
  dropExceeds: boolean;
  thresholdGb: number;
  missingCount: number;
  /** Every file present in the previous snapshot but absent now. */
  missing: SnapshotFileEntry[];
  addedCount: number;
  suspectPartialRead: boolean;
  /** Whether an alert push was warranted (and not suppressed by the already-alerted ledger) this run. */
  alerted: boolean;
}
