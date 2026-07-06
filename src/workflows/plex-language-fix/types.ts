// Shared types for the Plex per-title original-language audio/subtitle default audit.

export interface PlexStream {
  id: number;
  streamType: number; // 1 video, 2 audio, 3 subtitle
  index?: number;
  selected?: boolean;
  default?: boolean;
  forced?: boolean;
  codec?: string;
  channels?: number;
  language?: string;
  languageTag?: string;
  languageCode?: string;
  title?: string;
  displayTitle?: string;
  extendedDisplayTitle?: string;
}

export interface PlexPart {
  id: number;
  file?: string;
  Stream?: PlexStream[];
}

export interface PlexMedia {
  id: number;
  Part?: PlexPart[];
}

export interface PlexGuid {
  id: string; // e.g. "tmdb://1429"
}

export interface PlexMetadataItem {
  ratingKey: string;
  title: string;
  type: string; // 'show' | 'movie' | 'episode'
  originalTitle?: string;
  Guid?: PlexGuid[];
  Media?: PlexMedia[];
  parentTitle?: string;
  grandparentTitle?: string;
  index?: number;
  parentIndex?: number;
  leafCount?: number;
}

export interface PlexSection {
  key: string;
  type: string; // 'movie' | 'show'
  title: string;
}

/** A stream selection captured (or proposed) for one file. */
export interface StreamChoice {
  streamId: number | null; // null = "no explicit stream / none"
  label: string;
  languageTag?: string;
  /** True only when this came from a real Plex `selected` flag on the stream —
   *  false when it's just the effective default (the file's own baked-in
   *  `default` flag, or first-by-index), which is NOT pinned server-side and so
   *  can still be silently overridden by a client's own language preference. */
  isExplicit: boolean;
}

/**
 * Every genuine tie is resolved deterministically by `pickAudioCandidate`'s
 * existing best-judgment heuristic (original-mix label, then highest channel
 * count, then codec quality, then lowest stream index) — there is no 4th
 * "ambiguous" carve-out. A tie always ends up as either `'change'` or
 * `'already-correct'`, never a status of its own.
 */
export type FileStatus = 'change' | 'already-correct' | 'no-match';

export interface FileEntry {
  itemRatingKey: string;
  itemTitle: string; // episode/movie title
  seasonEpisode?: string; // e.g. "S01E01" for episodes
  partId: number;
  file?: string;
  status: FileStatus;
  currentAudio: StreamChoice;
  currentSubtitle: StreamChoice;
  proposedAudio?: StreamChoice;
  proposedSubtitle?: StreamChoice;
  /** Which candidate language (from the item's spoken_languages -> original_language waterfall) this file actually matched. */
  resolvedLanguage?: string;
  note?: string;
}

export interface ShowOrMovieEntry {
  sectionTitle: string;
  ratingKey: string;
  title: string;
  type: 'show' | 'movie';
  tmdbId?: number;
  originalLanguage?: string;
  spokenLanguages?: { code: string; name: string }[];
  /** The ordered list of language codes tried for every file in this title: spoken_languages in TMDB order, then original_language as a final fallback. */
  candidateLanguages?: string[];
  skippedReason?: string; // set when we didn't process files at all (no tmdb id / lookup failure)
  files: FileEntry[];
}

/** The workflow's output artifact — the full scan of every show/movie's files. */
export interface LanguageScanFile {
  generatedAt: string;
  sectionsScanned: string[];
  items: ShowOrMovieEntry[];
}

/** A stream's id + label as applied (or as it was before applying) — enough for undo to revert it. */
export interface AppliedStreamState {
  streamId: number;
  label: string;
}

/**
 * One file's before/after record from an apply run — self-contained (carries
 * BOTH before and after) so `scripts/plex-language-undo.ts` never has to
 * cross-reference the scan file to compute a revert.
 */
export interface AppliedChangeEntry {
  partId: number;
  file?: string;
  itemTitle: string;
  beforeAudio: AppliedStreamState | null;
  afterAudio: AppliedStreamState | null;
  beforeSubtitle: AppliedStreamState | null;
  afterSubtitle: AppliedStreamState | null;
  outcome: 'applied' | 'failed';
  error?: string;
  at: string;
}

/** The per-run applied-changes log written by `plex-language-apply`. */
export interface AppliedLog {
  generatedAt: string;
  butlerBackup: { ok: boolean; error?: string };
  entries: AppliedChangeEntry[];
}
