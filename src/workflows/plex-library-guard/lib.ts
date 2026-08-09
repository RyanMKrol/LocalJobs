// Pure snapshot/diff/alert helpers (no I/O beyond the two JSON file helpers),
// unit-tested in plex-library-guard.test.ts.
import { existsSync, readFileSync } from 'node:fs';
import { ensureDirs as coreEnsureDirs, writeJsonFile } from '../../core/fsjson.js';
import { plexLibraryGuardConfig } from './config.js';
import type {
  GuardEpisodeMeta,
  GuardMovieMeta,
  GuardPart,
  GuardReportFile,
  LibrarySnapshotFile,
  SnapshotFileEntry,
} from './types.js';

export function ensureDirs(): void {
  coreEnsureDirs(plexLibraryGuardConfig.outDir);
}

export { writeJsonFile };

// Deliberate local copy of plex-space-saver's formatBytes: this guard is a
// safety net and must not break if the workflow it superseded is later
// restructured or deleted, so it imports nothing from other workflows.
/** Format a byte count as a human-readable size (binary units, matching Plex's own GB display). */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

/**
 * Stable identity for one media file: `<ratingKey>::<part.id>`, falling back to
 * the part's `file` path and finally to its index within the item when Plex
 * omits both (never observed, but the key must always exist).
 */
export function partKey(ratingKey: string, part: GuardPart, index: number): string {
  const partId = typeof part.id === 'number' ? String(part.id) : part.file ? part.file : `#${index}`;
  return `${ratingKey}::${partId}`;
}

function pad2(n: number | undefined): string {
  return String(n ?? 0).padStart(2, '0');
}

function entriesForItem(
  ratingKey: string,
  type: 'movie' | 'episode',
  title: string,
  media: { Part?: GuardPart[] }[] | undefined,
): SnapshotFileEntry[] {
  const entries: SnapshotFileEntry[] = [];
  let index = 0;
  for (const m of media ?? []) {
    for (const part of m.Part ?? []) {
      entries.push({
        key: partKey(ratingKey, part, index),
        ratingKey,
        type,
        title,
        file: typeof part.file === 'string' && part.file.length > 0 ? part.file : null,
        bytes: typeof part.size === 'number' ? part.size : 0,
      });
      index += 1;
    }
  }
  return entries;
}

/** One entry per movie file (a movie's parts each get their own entry). */
export function movieEntries(movies: GuardMovieMeta[]): SnapshotFileEntry[] {
  return movies.flatMap((m) => {
    const title = `${m.title ?? '(untitled)'}${typeof m.year === 'number' ? ` (${m.year})` : ''}`;
    return entriesForItem(String(m.ratingKey ?? ''), 'movie', title, m.Media);
  });
}

/** One entry per episode file, titled "Show — S01E03 — Episode name". */
export function episodeEntries(episodes: GuardEpisodeMeta[]): SnapshotFileEntry[] {
  return episodes.flatMap((ep) => {
    const title = `${ep.grandparentTitle ?? '(unknown show)'} — S${pad2(ep.parentIndex)}E${pad2(ep.index)} — ${ep.title ?? '(untitled)'}`;
    return entriesForItem(String(ep.ratingKey ?? ''), 'episode', title, ep.Media);
  });
}

/** Build this run's full snapshot from the two live section listings. */
export function buildSnapshot(
  movies: GuardMovieMeta[],
  episodes: GuardEpisodeMeta[],
  movieSection: string,
  tvSection: string,
  now: Date,
): LibrarySnapshotFile {
  const files = [...movieEntries(movies), ...episodeEntries(episodes)];
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  return {
    generatedAt: now.toISOString(),
    movieSection,
    tvSection,
    totalBytes,
    totalHuman: formatBytes(totalBytes),
    fileCount: files.length,
    files,
  };
}

/** Read the persisted prior snapshot, or `null` on first run / malformed file. */
export function readSnapshot(path: string): LibrarySnapshotFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as LibrarySnapshotFile;
    if (typeof parsed?.generatedAt !== 'string' || typeof parsed?.totalBytes !== 'number' || !Array.isArray(parsed?.files)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** The outcome of diffing this run's snapshot against the previous one. */
export interface SnapshotDiff {
  /** `prev.totalBytes - current.totalBytes` (positive = shrink). */
  dropBytes: number;
  /** Whether the drop exceeds the configured GB threshold. */
  dropExceeds: boolean;
  /** Files present in the previous snapshot but absent now. */
  missing: SnapshotFileEntry[];
  /** Files present now that were not in the previous snapshot (logged, never alerted). */
  addedCount: number;
}

/**
 * Diff the previous snapshot against this run's. A missing file is one whose
 * key was in the previous inventory but not the current one. The size check is
 * a plain total comparison: any drop beyond `thresholdGb` (default 0, meaning
 * any decrease at all) is alert-worthy.
 */
export function diffSnapshots(prev: LibrarySnapshotFile, current: LibrarySnapshotFile, thresholdGb: number): SnapshotDiff {
  const currentKeys = new Set(current.files.map((f) => f.key));
  const prevKeys = new Set(prev.files.map((f) => f.key));
  const missing = prev.files.filter((f) => !currentKeys.has(f.key));
  const addedCount = current.files.filter((f) => !prevKeys.has(f.key)).length;
  const dropBytes = prev.totalBytes - current.totalBytes;
  return {
    dropBytes,
    dropExceeds: dropBytes > thresholdGb * 1024 ** 3,
    missing,
    addedCount,
  };
}

/**
 * Suspect-partial-read guard constants: when MORE than half the previous
 * inventory looks missing at once (and the previous inventory was big enough
 * for a ratio to mean anything), the far likelier explanation is a transient
 * bad Plex read than a genuine mass deletion. The run still alerts loudly (a
 * real mass deletion IS the disaster case) but preserves the baseline and
 * fails, so a misread self-heals next run. Code constants, deliberately not
 * env: they are safety parameters, not tuning knobs.
 */
export const SUSPECT_MISSING_RATIO = 0.5;
export const SUSPECT_MIN_PREV_FILES = 10;

export function isSuspectRead(prevFileCount: number, missingCount: number): boolean {
  return prevFileCount >= SUSPECT_MIN_PREV_FILES && missingCount / prevFileCount > SUSPECT_MISSING_RATIO;
}

/** At most this many missing files are named in the push body (the report always has all of them). */
export const ALERT_LIST_CAP = 20;

/**
 * Build the single combined alert push for this run, or `null` when there is
 * nothing to alert (no size drop beyond threshold, no missing files). One push
 * covers both signals: a drop and missing files are usually the same event.
 */
export function buildAlertPush(
  diff: SnapshotDiff,
  prev: LibrarySnapshotFile,
  current: LibrarySnapshotFile,
): { title: string; body: string } | null {
  if (!diff.dropExceeds && diff.missing.length === 0) return null;

  const parts: string[] = [];
  if (diff.missing.length > 0) parts.push(`${diff.missing.length} file(s) missing`);
  if (diff.dropExceeds) parts.push(`-${formatBytes(Math.max(diff.dropBytes, 0))}`);
  const title = `Plex library guard: ${parts.join(', ')}`;

  const lines: string[] = [
    `${formatBytes(prev.totalBytes)} (${prev.fileCount} files) → ${current.totalHuman} (${current.fileCount} files) since ${prev.generatedAt}.`,
  ];
  if (diff.missing.length > 0) {
    for (const f of diff.missing.slice(0, ALERT_LIST_CAP)) {
      lines.push(`• ${f.title}${f.file ? ` (${f.file})` : ''}`);
    }
    if (diff.missing.length > ALERT_LIST_CAP) {
      lines.push(`…and ${diff.missing.length - ALERT_LIST_CAP} more (see guard-report.json).`);
    }
  }
  return { title, body: lines.join('\n') };
}

/** Build the small always-written per-run report. */
export function buildReport(
  current: LibrarySnapshotFile,
  prev: LibrarySnapshotFile | null,
  diff: SnapshotDiff | null,
  thresholdGb: number,
  suspectPartialRead: boolean,
  alerted: boolean,
): GuardReportFile {
  return {
    generatedAt: current.generatedAt,
    firstRun: prev === null,
    totalBytes: current.totalBytes,
    totalHuman: current.totalHuman,
    fileCount: current.fileCount,
    prev: prev ? { generatedAt: prev.generatedAt, totalBytes: prev.totalBytes, fileCount: prev.fileCount } : null,
    dropBytes: diff?.dropBytes ?? 0,
    dropExceeds: diff?.dropExceeds ?? false,
    thresholdGb,
    missingCount: diff?.missing.length ?? 0,
    missing: diff?.missing ?? [],
    addedCount: diff?.addedCount ?? 0,
    suspectPartialRead,
    alerted,
  };
}
