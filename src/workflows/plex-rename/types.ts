// Shared types for the plex-rename workflow (canonical Plex library renamer).
import type { ArtworkSelection } from './artwork.js';
import type { EpisodeRef, MovieRef, NamingOp, ShowRef, SkipReason } from './naming.js';

// ── Plex API shapes (richer than plex-language-fix's — year/date/edition matter here) ──

export interface PlexGuid {
  id: string; // e.g. "tmdb://1429", "tvdb://305074", "imdb://tt1179933"
}

export interface PlexPart {
  id: number;
  file?: string;
  size?: number;
}

export interface PlexMedia {
  id: number;
  Part?: PlexPart[];
}

export interface PlexMetadataItem {
  ratingKey: string;
  title: string;
  type: string; // 'movie' | 'show' | 'episode'
  year?: number;
  originallyAvailableAt?: string; // "YYYY-MM-DD"
  editionTitle?: string;
  Guid?: PlexGuid[];
  Media?: PlexMedia[];
  parentTitle?: string;
  grandparentTitle?: string;
  /** Season / show the episode belongs to. Both are rebuilt when folders change,
   *  so confirm resolves them fresh rather than trusting the pre-move values. */
  parentRatingKey?: string;
  grandparentRatingKey?: string;
  index?: number;
  parentIndex?: number;
}

export interface PlexSectionLocation {
  id?: number;
  path?: string;
}

export interface PlexSection {
  key: string;
  type: string; // 'movie' | 'show'
  title: string;
  /** The section's library root folder(s), Plex-side — the authoritative LibraryRoot source. */
  Location?: PlexSectionLocation[];
}

// ── Path mapping (Plex-side ↔ Mac-side) ──

export interface PathMapPair {
  /** Plex-side prefix, e.g. "/volume1/NAS-Cool Shared Drive". */
  plex: string;
  /** Local (Mac Mini) prefix, e.g. "/Volumes/NAS-Cool Shared Drive". */
  local: string;
}

// ── Stage ledger `detail` shapes ──

/**
 * The `plex-rename-discover` ledger's per-file detail — a SNAPSHOT re-recorded
 * every run (unlike plex-language-fix's once-ever discover), because a renamed
 * file's refreshed `Part.file` is exactly how the pipeline converges to
 * `already-canonical` after a successful rename + Plex rescan.
 */
export interface DiscoverDetail {
  name: string; // e.g. "<Show> — s02e05" or "<Movie Title> (Year)"
  kind: 'movie' | 'episode';
  file: string; // Part.file — current Plex-side path
  partId: number;
  partSize?: number;
  mediaCount: number;
  partCount: number;
  partIndex: number;
  /** The library root (Plex-side) this file lives under, from the section's own Location. */
  rootPath: string;
  movie?: MovieRef;
  show?: ShowRef;
  episodes?: EpisodeRef[];
}

export type PlanDecisionKind = 'rename' | 'already-canonical' | 'skip';

/** The `plex-rename-plan` ledger's per-file detail — recomputed every run (derived state). */
export interface PlanDetail {
  name: string;
  decision: PlanDecisionKind;
  from: string; // current Plex-side path
  to?: string; // canonical Plex-side target (rename / already-canonical)
  reason?: SkipReason;
  reasonDetail?: string;
  /** The file's OWN library root (where it currently lives). */
  rootPath?: string;
  /** The root the TARGET lives under — the show's consolidated home root when it
   *  differs from rootPath (cross-share move); the plan→verify gate asserts
   *  to.startsWith(targetRootPath). */
  targetRootPath?: string;
  /** Engine ops for a 'rename' decision (Plex-side paths; media move + mkdir + optional plexmatch). */
  ops?: NamingOp[];
}

export type VerifyIneligibleReason =
  | 'unmapped-path'
  | 'mount-missing'
  | 'file-missing'
  | 'too-recent'
  | 'size-mismatch'
  | 'size-unknown'
  | 'target-exists'
  | 'sidecar-collision'
  | 'existing-plexmatch'
  | 'not-a-rename';

export interface SidecarMove {
  /** Plex-side paths (apply maps them local at execution time). */
  from: string;
  to: string;
  role: 'sidecar' | 'asset';
}

/**
 * The `plex-rename-verify` ledger's per-file detail — the local-disk reality
 * check, recomputed every run. `eligible: true` rows are the ONLY input the
 * mutating apply stage accepts, and the verify→apply gate asserts their shape.
 */
export interface VerifyDetail {
  name: string;
  eligible: boolean;
  reason?: VerifyIneligibleReason;
  reasonDetail?: string;
  from: string; // Plex-side source
  to: string; // Plex-side target
  localFrom?: string;
  localTo?: string;
  caseOnly?: boolean;
  /** Verified size on disk (must equal Plex's Part.size), bytes. */
  bytes?: number;
  /** Sidecars/assets that move in lockstep (enumerated from the REAL directory listing). */
  sidecars?: SidecarMove[];
  /** .plexmatch to write into the target show dir (episodes only; omitted when one already matches). */
  plexmatch?: { dir: string; content: string };
  /** Files deliberately left behind in the source dir (report). */
  leftBehind?: string[];
}

/** The `plex-rename-apply` ledger's per-file detail — once-ever, permanent. */
export interface ApplyDetail {
  name: string;
  from: string; // Plex-side source (as it was)
  to: string; // Plex-side target (where the file now lives)
  sha256: string;
  bytes: number;
  sidecarCount: number;
  appliedAt: string; // ISO — confirm's grace window anchors here
  /** The per-run report markdown (T110 View popover). */
  markdown?: string;
  /** What artwork the owner had showing before the move, so confirm can restore it
   *  if Plex recreates the entry and reverts to the agent default (see artwork.ts). */
  artwork?: ArtworkSelection;
}

/** The `plex-rename-confirm` ledger's per-file detail. */
export interface ConfirmDetail {
  name: string;
  confirmed: boolean;
  reason?: 'pending-rescan' | 'grace-exceeded' | 'ratingkey-gone' | 'reassociated';
  reasonDetail?: string;
  confirmedPath?: string;
  /** Set when confirmation came via a NEW ratingKey owning the target path (consolidation merge). */
  confirmedRatingKey?: string;
}
