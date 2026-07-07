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
 * "ambiguous" carve-out. `'already-correct'` and `'no-match'` were collapsed
 * into a single `'skip'` outcome in T453 (both mean "apply does nothing"; the
 * `note` field still records WHY when it's a no-match).
 */
export type FileStatus = 'change' | 'skip';

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

/**
 * The `plex-language-discover` ledger's per-file `detail` (T453). Recorded once
 * per file, forever — the identity + the show/movie's tmdb id, so later stages
 * never need to re-walk Plex's section tree to find a file again. `itemRatingKey`
 * is the file's OWN rating key (a movie's own key, or an episode leaf's own key —
 * NOT the parent show's key, since a per-file identity is what the ledger keys on).
 */
export interface DiscoverDetail {
  name: string; // e.g. "<Show> — S04E12" or "<Movie Title>"
  file?: string;
  itemRatingKey: string;
  partId: number;
  type: 'movie' | 'show';
  tmdbId: number;
  seasonEpisode?: string;
}

/** The `plex-language-resolve` ledger's per-file `detail` (T453). */
export interface ResolveDetail {
  name: string;
  originalLanguage?: string;
  candidateLanguages: string[];
}

/**
 * The `plex-language-evaluate` ledger's per-file `detail` (T453). Carries the
 * CURRENT audio/subtitle selection as observed at evaluate time (not re-fetched
 * at apply time) so `plex-language-apply` can record a real before/after in its
 * applied-changes log — the same undo-log contract `scripts/plex-language-undo.ts`
 * relies on.
 */
export interface EvaluateDetail {
  name: string;
  status: FileStatus;
  currentAudio: StreamChoice;
  currentSubtitle: StreamChoice;
  proposedAudio?: StreamChoice;
  proposedSubtitle?: StreamChoice;
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
